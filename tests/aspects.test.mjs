// ═══════════════════════════════════════════════════════════════════════════
//  Item specifics — what a listing ends up SAYING about the part.
//
//  Every assertion here is about a value that reaches eBay. The three that
//  matter most:
//    • a REQUIRED aspect left empty fails the publish, so Pass 3 must always
//      land on something — and something honest, not just allowed[0];
//    • "Manufacturer Warranty" is a warranty PERIOD, and filling it with the
//      make is a real bug that was fixed once already;
//    • the Compatible Year aspect is what eBay search matches a buyer's car
//      against, so an unbounded year expansion lists the part for cars it does
//      not fit.
//
//  Run: node --experimental-strip-types tests/aspects.test.mjs
// ═══════════════════════════════════════════════════════════════════════════
import {
  parseAspectSpecs, placementFromTitle, deriveAspect, applyDerived, aspectsToAsk,
  aspectPromptList, applyAiAspects, ensureDonorFitment, compatibilityAspects,
  fillRequiredNeutral, applyWarranty, applyOverrides, inAllowedOf, NEUTRAL_VALUES,
  expandYears, MAX_ASPECT_VALUES, MAX_YEARS_PER_FITMENT, SPECIFICS_SYSTEM_PROMPT,
} from '../supabase/functions/ebay-import/ebay/aspects.ts'

let pass = 0, fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
const deep = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

// A spec as eBay's taxonomy hands it to us.
const spec = (name, o = {}) => ({ name, required: !!o.required, selectionOnly: !!o.selectionOnly, allowed: o.allowed || [] })
const PART = {
  title: 'Ford Falcon FG Front Left Headlight Halogen',
  make: 'Ford', model: 'Falcon', year: '2008-2014', part_number: 'BA-1234',
}

console.log('\nparseAspectSpecs — reading eBay\'s taxonomy reply\n')
{
  const parsed = parseAspectSpecs({
    aspects: [
      { localizedAspectName: 'Brand', aspectConstraint: { aspectRequired: true, aspectMode: 'FREE_TEXT' } },
      { localizedAspectName: 'Type', aspectConstraint: { aspectMode: 'SELECTION_ONLY' }, aspectValues: [{ localizedValue: 'Headlight' }, { localizedValue: 'Fog Light' }, {}] },
    ],
  })
  eq('reads two aspects', parsed.length, 2)
  eq('required survives', parsed[0].required, true)
  eq('SELECTION_ONLY survives', parsed[1].selectionOnly, true)
  deep('allowed values drop the blanks', parsed[1].allowed, ['Headlight', 'Fog Light'])
  eq('a missing constraint block is not required', parsed[1].required, false)
}
// A publish must not die because the taxonomy reply was not the shape we expect.
deep('no aspects key → empty list, not a throw', parseAspectSpecs({}), [])
deep('null reply → empty list', parseAspectSpecs(null), [])
ok('a nameless aspect is dropped rather than becoming an undefined key on the listing',
  parseAspectSpecs({ aspects: [{ aspectConstraint: {} }, { localizedAspectName: 'Brand' }] }).length === 1)

console.log('\nplacementFromTitle — which corner of the car\n')
eq('front left', placementFromTitle('Ford Falcon Front Left Headlight'), 'Front, Left')
eq('abbreviations count', placementFromTitle('Falcon RH Rear Door'), 'Rear, Right')
eq('driver means left in an AU yard', placementFromTitle('Falcon Driver Side Mirror'), 'Left')
eq('slashed abbreviation', placementFromTitle('Falcon L/H Guard'), 'Left')
eq('nothing positional → null, so the AI is asked instead', placementFromTitle('Ford Falcon ECU'), null)
eq('order is fixed, not title order', placementFromTitle('Left Rear Lamp'), 'Rear, Left')
// "frontal" must not read as "front" — \b is doing real work here.
eq('a word merely containing "front" is not a placement', placementFromTitle('Frontal Impact Sensor'), null)
eq('missing title is survivable', placementFromTitle(undefined), null)

console.log('\nderiveAspect — what our own data can answer\n')
eq('Brand takes the make', deriveAspect('Brand', PART), 'Ford')
eq('Manufacturer takes the make', deriveAspect('Manufacturer', PART), 'Ford')
// The bug this whole branch exists to prevent: a listing offering "Ford" months
// of warranty. applyWarranty owns this aspect; derive must not touch it.
eq('Manufacturer Warranty is a PERIOD and must NOT take the make', deriveAspect('Manufacturer Warranty', PART), null)
eq('Manufacturer Part Number is a number, not the make', deriveAspect('Manufacturer Part Number', PART), 'BA-1234')
eq('MPN', deriveAspect('MPN', PART), 'BA-1234')
eq('OE/OEM Part Number', deriveAspect('OE/OEM Part Number', PART), 'BA-1234')
eq('Interchange Part Number', deriveAspect('Interchange Part Number', PART), 'BA-1234')
eq('Model', deriveAspect('Model', PART), 'Falcon')
eq('Year takes the string as-is', deriveAspect('Year', PART), '2008-2014')
eq('Placement is read from the title', deriveAspect('Placement on Vehicle', PART), 'Front, Left')
// eBay's "Type" means the product type, not our internal taxonomy.
eq('Type is left for the photo', deriveAspect('Type', { ...PART, category: 'Lighting' }), null)
eq('an unknown aspect is left for the photo', deriveAspect('Surface Finish', PART), null)
eq('a blank field derives nothing rather than an empty string', deriveAspect('Model', { make: 'Ford', model: '' }), null)

console.log('\napplyDerived — Pass 1\n')
{
  const specs = [spec('Brand'), spec('Model'), spec('Surface Finish')]
  const a = applyDerived(specs, PART, {})
  deep('fills what it can', a, { Brand: ['Ford'], Model: ['Falcon'] })
  ok('leaves the rest for the AI', !('Surface Finish' in a))
}
{
  // A SELECTION_ONLY aspect only accepts a value off eBay's list, verbatim.
  const specs = [spec('Brand', { selectionOnly: true, allowed: ['FORD', 'Holden'] })]
  deep('a selection-only match is written back in eBay\'s own casing',
    applyDerived(specs, PART, {}), { Brand: ['FORD'] })
}
{
  const specs = [spec('Brand', { selectionOnly: true, allowed: ['Toyota', 'Holden'] })]
  deep('a derived value not on the list is dropped, never coerced',
    applyDerived(specs, PART, {}), {})
}
{
  const specs = [spec('Brand')]
  deep('an existing value is never overwritten',
    applyDerived(specs, PART, { Brand: ['Genuine Ford'] }), { Brand: ['Genuine Ford'] })
}

console.log('\naspectsToAsk / aspectPromptList — what the vision model is shown\n')
{
  const specs = Array.from({ length: 40 }, (_, i) => spec(`A${i}`))
  eq('capped at 30 so a big category cannot blow the prompt', aspectsToAsk(specs, {}).length, 30)
  eq('already-filled aspects are not asked about', aspectsToAsk([spec('Brand'), spec('Type')], { Brand: ['Ford'] }).length, 1)
}
{
  const list = aspectPromptList([
    spec('Type', { selectionOnly: true, allowed: ['Headlight', 'Fog Light'] }),
    spec('Colour'),
  ])
  ok('a choose-one aspect shows its options', list.includes('choose exactly one, verbatim: Headlight | Fog Light'))
  ok('a free-text aspect says so', list.includes('- Colour (free text, max 60 chars)'))
}
{
  const many = aspectPromptList([spec('Type', { selectionOnly: true, allowed: Array.from({ length: 60 }, (_, i) => `V${i}`) })])
  ok('a very long option list is truncated at 40', many.includes('V39') && !many.includes('V40'))
}

console.log('\napplyAiAspects — Pass 2\n')
{
  const todo = [spec('Colour'), spec('Type', { selectionOnly: true, allowed: ['Headlight'] })]
  deep('free text and a valid choice both land',
    applyAiAspects(todo, { Colour: 'Black', Type: 'headlight' }, {}),
    { Colour: ['Black'], Type: ['Headlight'] })
}
{
  const todo = [spec('Type', { selectionOnly: true, allowed: ['Headlight'] })]
  deep('an invented option is DROPPED — eBay would refuse the publish',
    applyAiAspects(todo, { Type: 'Xenon Projector Assembly' }, {}), {})
}
{
  const todo = [spec('Colour')]
  const long = 'x'.repeat(200)
  eq('free text is cut to 65 chars', applyAiAspects(todo, { Colour: long }, {}).Colour[0].length, 65)
}
{
  const todo = [spec('Colour'), spec('Type')]
  deep('non-strings and blanks are ignored, not stringified',
    applyAiAspects(todo, { Colour: 42, Type: '' }, {}), {})
}
{
  const todo = [spec('Colour')]
  deep('a null reply from the model leaves the aspects alone', applyAiAspects(todo, null, { Brand: ['Ford'] }), { Brand: ['Ford'] })
}

console.log('\nensureDonorFitment — the one car we know for certain\n')
{
  const f = ensureDonorFitment([{ make: 'Holden', model: 'Commodore' }], PART)
  eq('the donor is prepended', f.length, 2)
  eq('and it is first', f[0].model, 'Falcon')
  eq('the year range is read off the part', f[0].yearFrom, 2008)
  eq('to the second year', f[0].yearTo, 2014)
}
{
  const f = ensureDonorFitment([{ make: 'ford', model: 'FALCON', yearFrom: 2010 }], PART)
  eq('an existing donor entry is not duplicated on a case difference', f.length, 1)
}
{
  const f = ensureDonorFitment([], { make: 'Ford', model: 'Falcon', year: '2010' })
  eq('a single year becomes from and to', `${f[0].yearFrom}-${f[0].yearTo}`, '2010-2010')
}
{
  const f = ensureDonorFitment([], { make: 'Ford', model: 'Falcon' })
  eq('no year at all is still a valid fitment row', f.length, 1)
  eq('with no invented years', f[0].yearFrom, undefined)
}
deep('a part with no make/model adds nothing', ensureDonorFitment([], { title: 'Mystery bracket' }), [])

console.log('\ncompatibilityAspects — what eBay search matches a buyer\'s car against\n')
{
  const specs = [spec('Compatible Make'), spec('Compatible Model'), spec('Compatible Year'), spec('Brand')]
  const a = compatibilityAspects(specs, [
    { make: 'Ford', model: 'Falcon', yearFrom: 2008, yearTo: 2010 },
    { make: 'Ford', model: 'Territory', yearFrom: 2009, yearTo: 2009 },
  ], {})
  deep('makes are de-duplicated', a['Compatible Make'], ['Ford'])
  deep('models are not', a['Compatible Model'], ['Falcon', 'Territory'])
  deep('years expand and de-duplicate', a['Compatible Year'], ['2008', '2009', '2010'])
  ok('a non-compat aspect is untouched', !('Brand' in a))
}
{
  const a = compatibilityAspects([spec('Compatible Year')], [{ make: 'Ford', model: 'Falcon', yearFrom: 2015 }], {})
  deep('a missing yearTo means the one year, not an open range', a['Compatible Year'], ['2015'])
}
{
  // ⚠ PINNED DEFECT, not a passing behaviour. The aspect is capped at 30 values
  // and Compatible Year reaches that cap on any part fitting three or four cars
  // with real production runs. What survives is fitment ORDER — the order the
  // model answered in — so the years dropped belong to whichever vehicle it
  // happened to mention last. Here the Commodore is listed under Compatible
  // Model while every Commodore year from 1988 is cut.
  //
  // Left unfixed on purpose: 30 may be eBay's own per-aspect limit and raising
  // it blind risks a rejected publish. See the note in aspects.ts.
  //
  // The saving grace, asserted below so it cannot quietly stop being true: this
  // is the item-specifics copy. eBay search matches on the Parts Compatibility
  // list, which index.ts builds per-vehicle up to 200 products and which this
  // cap does not touch.
  const fitment = [
    { make: 'Ford', model: 'Falcon', yearFrom: 1998, yearTo: 2016 },
    { make: 'Toyota', model: 'Corolla', yearFrom: 2001, yearTo: 2024 },
    { make: 'Holden', model: 'Commodore', yearFrom: 1985, yearTo: 1995 },
  ]
  const a = compatibilityAspects([spec('Compatible Year'), spec('Compatible Model')], fitment, {})
  const claimed = new Set(fitment.flatMap(expandYears))
  const dropped = [...claimed].filter(y => !a['Compatible Year'].includes(y)).sort()
  eq('the fitment claims 38 model years', claimed.size, 38)
  eq('only 30 are sent', a['Compatible Year'].length, MAX_ASPECT_VALUES)
  deep('and these are silently dropped', dropped, ['1988', '1989', '1990', '1991', '1992', '1993', '1994', '1995'])
  ok('while the Commodore is still listed as a compatible model — the inconsistency',
    a['Compatible Model'].includes('Commodore'))
}

console.log('\nexpandYears — one definition, used by the specifics AND the compatibility list\n')
deep('a range expands inclusively', expandYears({ yearFrom: 2010, yearTo: 2013 }), ['2010', '2011', '2012', '2013'])
deep('no yearTo means the one year', expandYears({ yearFrom: 2015 }), ['2015'])
deep('no yearFrom means no years — the caller sends make+model with no Year', expandYears({ model: 'Falcon' }), [])
deep('a junk row yields nothing rather than throwing', expandYears(null), [])
// A model-invented yearTo of 2500 must not crowd every other vehicle out of the
// 200-product compatibility payload.
// The literal, not the constant: asserting against MAX_YEARS_PER_FITMENT would
// move with any change to it and prove nothing. 40 years is a deliberate number
// — long enough for any real production run, short enough that a junk range
// cannot crowd other vehicles out of the 200-product compatibility payload.
eq('the bound is 40 model years per fitment row', MAX_YEARS_PER_FITMENT, 40)
eq('an absurd yearTo is bounded to it', expandYears({ yearFrom: 1990, yearTo: 2500 }).length, 40)
eq('so 2029 is the last year sent', expandYears({ yearFrom: 1990, yearTo: 2500 }).at(-1), '2029')
eq('and the bound starts from the real yearFrom', expandYears({ yearFrom: 1990, yearTo: 2500 })[0], '1990')
// A backwards range is junk; yielding no years is right, because the
// compatibility builder then sends make+model with no Year rather than a lie.
deep('a backwards range yields no years', expandYears({ yearFrom: 2015, yearTo: 2010 }), [])
eq('a string year still works — the AI does not always send numbers', expandYears({ yearFrom: '2010', yearTo: '2011' }).length, 2)
{
  const specs = [spec('Compatible Make', { allowed: ['Ford', 'Holden'] })]
  deep('a value off the allowed list is filtered out',
    compatibilityAspects(specs, [{ make: 'Ford' }, { make: 'Nissan' }], {})['Compatible Make'], ['Ford'])
}
deep('an empty fitment writes nothing', compatibilityAspects([spec('Compatible Make')], [], {}), {})

console.log('\nfillRequiredNeutral — Pass 3, the aspect that would fail the publish\n')
{
  const specs = [spec('Brand', { required: true }), spec('Colour', { required: false })]
  const a = fillRequiredNeutral(specs, PART, {})
  deep('a required free-text Brand falls back to the make', a.Brand, ['Ford'])
  ok('an OPTIONAL empty aspect is left empty — a listing should not claim what we do not know', !('Colour' in a))
}
{
  const specs = [spec('Brand', { required: true, allowed: ['Unbranded', 'Ford'] })]
  deep('with a list, Unbranded is preferred over guessing a brand', fillRequiredNeutral(specs, PART, {}).Brand, ['Unbranded'])
}
{
  const specs = [spec('Country/Region of Manufacture', { required: true, allowed: ['China', 'Unknown', 'Japan'] })]
  deep('a neutral option beats the first item on the list',
    fillRequiredNeutral(specs, PART, {})['Country/Region of Manufacture'], ['Unknown'])
}
{
  const specs = [spec('Surface Finish', { required: true, allowed: ['Painted', 'Chrome'] })]
  deep('with no neutral option we take the first rather than fail the publish',
    fillRequiredNeutral(specs, PART, {})['Surface Finish'], ['Painted'])
}
{
  const specs = [spec('Manufacturer Part Number', { required: true })]
  deep('a part with no number says so in eBay\'s own words',
    fillRequiredNeutral(specs, { make: 'Ford' }, {})['Manufacturer Part Number'], ['Does Not Apply'])
}
{
  const specs = [spec('Brand', { required: true })]
  deep('an already-filled required aspect is not overwritten',
    fillRequiredNeutral(specs, PART, { Brand: ['Genuine Ford'] }).Brand, ['Genuine Ford'])
}
ok('every neutral word is lower case, or the lookup silently never matches',
  NEUTRAL_VALUES.every(v => v === v.toLowerCase()))

console.log('\napplyWarranty — a PERIOD, set last and authoritative\n')
{
  const specs = [spec('Manufacturer Warranty')]
  deep('the store default wins', applyWarranty(specs, {}, { warranty: '3 Months' })['Manufacturer Warranty'], ['3 Months'])
}
{
  const specs = [spec('Manufacturer Warranty')]
  deep('unset falls back to 1 Month', applyWarranty(specs, {}, {})['Manufacturer Warranty'], ['1 Month'])
  deep('so does whitespace', applyWarranty(specs, {}, { warranty: '   ' })['Manufacturer Warranty'], ['1 Month'])
}
{
  // The whole reason this runs last: an earlier pass may have put a make here.
  const specs = [spec('Manufacturer Warranty')]
  deep('it overrides whatever an earlier pass left behind',
    applyWarranty(specs, { 'Manufacturer Warranty': ['Ford'] }, {})['Manufacturer Warranty'], ['1 Month'])
}
{
  const specs = [spec('Warranty', { selectionOnly: true, allowed: ['30 Days', '6 Months'] })]
  deep('1 Month is matched to eBay\'s "30 Days" rather than sent invalid',
    applyWarranty(specs, {}, { warranty: '1 Month' }).Warranty, ['30 Days'])
}
{
  const specs = [spec('Warranty', { selectionOnly: true, allowed: ['6 Months', '1 Year'] })]
  deep('no match and nothing already set → left unset rather than sent invalid',
    applyWarranty(specs, {}, { warranty: '1 Month' }), {})
}
{
  const specs = [spec('Warranty', { selectionOnly: true, allowed: ['6 Months', '1 Year'] })]
  deep('no match but a valid value already there → that value is kept',
    applyWarranty(specs, { Warranty: ['6 Months'] }, { warranty: '1 Month' }).Warranty, ['6 Months'])
}
{
  const specs = [spec('Warranty', { selectionOnly: true, allowed: ['6 Months', '1 Year'] })]
  deep('an exact listed value is matched case-insensitively',
    applyWarranty(specs, {}, { warranty: '1 year' }).Warranty, ['1 Year'])
}

console.log('\napplyOverrides — the user\'s corrections beat everything\n')
{
  const part = { ebay_overrides: { specifics: { Brand: 'Genuine Ford', Colour: '' } } }
  const { aspects } = applyOverrides(part, { Brand: ['Ford'], Colour: ['Black'], Type: ['Headlight'] }, [])
  deep('a correction replaces the filled value', aspects.Brand, ['Genuine Ford'])
  // A blank override means "do not send this", NOT "fall back to Unbranded".
  ok('a blank override REMOVES the aspect', !('Colour' in aspects))
  deep('everything else is untouched', aspects.Type, ['Headlight'])
}
{
  const part = { ebay_overrides: { fitment: [{ make: 'Ford', model: 'Territory' }] } }
  const { fitmentList } = applyOverrides(part, {}, [{ make: 'Ford', model: 'Falcon' }])
  deep('an overridden fitment REPLACES the computed one', fitmentList, [{ make: 'Ford', model: 'Territory' }])
}
{
  const { aspects, fitmentList } = applyOverrides({}, { Brand: ['Ford'] }, [{ make: 'Ford' }])
  deep('no overrides changes nothing', aspects, { Brand: ['Ford'] })
  deep('including the fitment', fitmentList, [{ make: 'Ford' }])
}
{
  const { fitmentList } = applyOverrides({ ebay_overrides: { fitment: 'not a list' } }, {}, [{ make: 'Ford' }])
  deep('a malformed fitment override is ignored, not sent', fitmentList, [{ make: 'Ford' }])
}

console.log('\nThe prompt and the code that reads its answer must agree\n')
ok('the prompt tells the model to return a listed option verbatim — applyAiAspects drops anything else',
  /verbatim/i.test(SPECIFICS_SYSTEM_PROMPT))
ok('the prompt asks for aspects and fitment, which is what the caller destructures',
  SPECIFICS_SYSTEM_PROMPT.includes('"aspects"') && SPECIFICS_SYSTEM_PROMPT.includes('"fitment"'))
eq('inAllowedOf returns eBay\'s casing, not ours', inAllowedOf(['Does Not Apply'], 'does not apply'), 'Does Not Apply')
eq('and undefined when there is no match', inAllowedOf(['A'], 'B'), undefined)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
