// eBay category id -> our top-level category. A hand-written floor, kept only as
// a fallback: the live path resolves ids from eBay's own taxonomy, cached in the
// ebay_category_lookup table (see refresh_category_tree). Anything not here and
// not in that cache imports with no category, which is what left 943 parts blank
// before 2026-08-24.
//
// Lives in a SUBDIRECTORY deliberately: the deploy command uploads to a
// remote bundler, and this file is the cheap test that the bundler follows a
// nested import graph before any real logic depends on it. A flat sibling
// (taxonomy.js) was already proven; this shape was not.
export const CATEGORY_ID_MAP: Record<string, string> = {
  '33549':'Air & Fuel Delivery','33542':'Air Conditioning & Heating',
  '33559':'Brakes & Brake Parts','33612':'Engines & Engine Parts',
  '33599':'Engine Cooling','33605':'Exhaust & Emission',
  '33637':'Exterior Parts','33687':'Ignition Systems',
  '33694':'Interior Parts','33707':'Lighting & Bulbs',
  '33572':'Starters, Alternators & Wiring','33579':'Steering & Suspension',
  '33726':'Transmission & Drivetrain','33743':'Wheels, Tyres & Parts',
  '180143':'Towing Parts','9886':'Other Car & Truck Parts',
  // Subcategories mapped to parent
  '50459':'Interior Parts','33705':'Interior Parts','33716':'Lighting & Bulbs',
  '33596':'Transmission & Drivetrain','262161':'Exterior Parts',
  '9887':'Other Car & Truck Parts','33712':'Lighting & Bulbs',
  '33648':'Exterior Parts','46102':'Interior Parts','61941':'Exterior Parts',
  '33706':'Interior Parts','33700':'Interior Parts','33545':'Interior Parts',
  '262085':'Brakes & Brake Parts','33557':'Air & Fuel Delivery',
  '33709':'Lighting & Bulbs','33566':'Brakes & Brake Parts',
  '262188':'Interior Parts','262221':'Starters, Alternators & Wiring',
  '33675':'Interior Parts','33558':'Air & Fuel Delivery',
  '262200':'Interior Parts','61304':'Engines & Engine Parts',
  '262183':'Ignition Systems','33546':'Air Conditioning & Heating',
  '173950':'Air & Fuel Delivery','183718':'Other Car & Truck Parts',
  '33704':'Interior Parts','39754':'Interior Parts',
}
