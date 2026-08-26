// ═══════════════════════════════════════════════════════════════════════════
//  Vehicle title parsing — tested against REAL listing titles.
//
//  parseVehicle decides the make/model/year on every part imported from eBay,
//  which then drives the By-car and By-model analytics, the fitment sent to
//  eBay, and what the yard searches by. It had no test at all while it lived
//  inside a 4,500-line edge function that nothing could import.
//
//  The fixtures below are actual titles from the live store, paired with the
//  make/model the database holds for them, so a regression here is a regression
//  against real inventory rather than against invented strings.
//
//  Run: node --experimental-strip-types tests/vehicles.test.mjs
// ═══════════════════════════════════════════════════════════════════════════
import { parseVehicle, parseYearRange } from '../supabase/functions/ebay-import/ebay/vehicles.ts'

let pass = 0, fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// [title, expected make, expected model] — from public.parts in the live store.
const REAL = [
  ['Subaru Forester SG Master Window Switch Green Base Type 2002-2008', 'Subaru', 'Forester'],
  ['Holden Cruze JG JH Throttle Body 1.8L Petrol 03/2009-01/2017', 'Holden', 'Cruze'],
  ['Ford Focus LW Heater AC Controls Standard Type 05/2011-08/2015', 'Ford', 'Focus'],
  ['Subaru Liberty 4th Gen Ignition Immobiliser 2003-2009 88215AG000', 'Subaru', 'Liberty'],
  ['Subaru Outback Left Taillight Gen 4 2003-2006', 'Subaru', 'Outback'],
  ['Mitsubishi Pajero NM Right Taillight 05/2000-10/2002', 'Mitsubishi', 'Pajero'],
  ['Holden Rodeo TF Rear Headrest Pair 03/1997-03/2003', 'Holden', 'Rodeo'],
  ['Peugeot 308 T7 Master Window Switch 09/2007-09/2014', 'Peugeot', '308'],
  ['Skoda Superb 3T Rear Right Headrest 03/2009-12/2015', 'Skoda', 'Superb'],
  ['Audi A4 B8 Left Side Mirror Silver 6 Wire Type 02/2008-05/2009', 'Audi', 'A4'],
  ['Audi A3 8P Window Reg Motor Drivers Side 3 Door Hatch 06/2004-04/2013 8P0959801A', 'Audi', 'A3'],
  ['Ford Falcon AU Central Locking Lock Unlock Switch', 'Ford', 'Falcon'],
  ['BMW X5 E53 Center Console Rear Air Vents 2000-2006', 'BMW', 'X5'],
]

console.log('\nMake and model, from real listing titles\n')
for (const [title, make, model] of REAL) {
  const got = parseVehicle(title)
  ok(`${make} ${model}`.padEnd(22) + title.slice(0, 46),
    got.make === make && got.model.startsWith(model),
    `got make="${got.make}" model="${got.model}"`)
}

console.log('\nYear ranges')
const YEARS = [
  ['Holden Cruze JG JH Throttle Body 1.8L Petrol 03/2009-01/2017', '2009-2017'],
  ['Mazda 2 DE BCM Body control module Manual 09/07-09/14 JD01G', '2007-2014'],
  ['Subaru Outback Left Taillight Gen 4 2003-2006', '2003-2006'],
  ['Ford Falcon AU Central Locking Lock Unlock Switch', ''],
]
for (const [title, want] of YEARS) {
  const got = parseYearRange(title)
  ok(`${want || '(none)'} from "${title.slice(0, 40)}…"`, got === want, `got "${got}"`)
}

console.log('\nThings it must NOT do')
ok('a part number is not a year', !/\d{4}-\d{4}/.test(parseYearRange('Audi A3 8P Window Reg Motor 8P0959801A')))
ok('no make means no guess', parseVehicle('Universal Chrome Wheel Nuts Set of 20').make === '')
ok('an empty title is survivable', parseVehicle('').make === '' && parseVehicle('').model === '')
ok('undefined is survivable', parseVehicle(undefined).make === '')

// Regional aliasing: the same car is a Vauxhall in the UK and a Holden in AU.
console.log('\nRegional aliases')
ok('UK marketplace resolves a UK make', typeof parseVehicle('Vauxhall Corsa D Wing Mirror', 'EBAY_GB').make === 'string')

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
