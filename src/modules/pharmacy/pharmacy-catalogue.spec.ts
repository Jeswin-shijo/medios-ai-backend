import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  MEDICINES,
  matchMedicine,
  medicineByKey,
  parseDose,
  parseDurationDays,
  pickProduct,
  productByKey,
  quantityFor,
  routeFor,
  sameKind,
} from './pharmacy-catalogue';

const product = (key: string) => {
  const p = productByKey(key);
  assert.ok(p, key);
  return p;
};

describe('medicine list', () => {
  test('holds 44 medicines and 75 products with unique keys', () => {
    assert.equal(MEDICINES.length, 44);
    const products = MEDICINES.flatMap((m) => m.products);
    assert.equal(products.length, 75);
    assert.equal(new Set(MEDICINES.map((m) => m.key)).size, 44);
    assert.equal(new Set(products.map((p) => p.key)).size, 75);
  });

  test('carries exactly the 20 kidney rows of the table', () => {
    const rows = MEDICINES.flatMap((m) =>
      m.kidney.map((k) => `${m.key} ${k.from}-${k.below} ${k.severity}`),
    ).sort();
    const expected = [
      'enoxaparin 0-30 red',
      'rosuvastatin 0-30 amber',
      'ramipril 0-30 amber',
      'spironolactone 0-30 red',
      'metformin 0-30 red',
      'metformin 30-45 amber',
      'glimepiride 0-30 amber',
      'amoxicillin-clavulanate 0-30 amber',
      'piperacillin-tazobactam 0-40 amber',
      'meropenem 0-50 amber',
      'ciprofloxacin 0-30 amber',
      'cotrimoxazole 0-30 amber',
      'vancomycin 0-50 amber',
      'diclofenac 0-30 red',
      'diclofenac 30-60 amber',
      'ibuprofen 0-30 red',
      'ibuprofen 30-60 amber',
      'tramadol 0-30 amber',
      'morphine 0-30 amber',
      'levetiracetam 0-50 amber',
    ].sort();
    assert.equal(rows.length, 20);
    assert.deepEqual(rows, expected);
  });

  test('pins the limits, classes, allergy groups and aliases of the table', () => {
    const m = (k: string) => medicineByKey(k)!;
    assert.deepEqual([m('aspirin').maxSingle, m('aspirin').maxDaily], [600, 4000]);
    assert.deepEqual([m('clopidogrel').maxSingle, m('clopidogrel').maxDaily], [600, 600]);
    assert.deepEqual([m('ticagrelor').maxSingle, m('ticagrelor').maxDaily], [180, 360]);
    assert.deepEqual(m('enoxaparin').perKg, { perKg: 1.1 });
    assert.equal(m('enoxaparin').maxSingle, 150);
    assert.deepEqual([m('heparin').maxSingle, m('heparin').maxDaily], [10000, 40000]);
    assert.deepEqual(m('paracetamol').perKg, { perKg: 15, underKg: 50 });
    assert.deepEqual([m('paracetamol').maxSingle, m('paracetamol').maxDaily], [1000, 4000]);
    assert.deepEqual(m('vancomycin').perKg, { perKg: 20 });
    assert.equal(m('normal-saline').maxDaily, undefined);
    assert.equal(m('ibuprofen').allergyGroup, 'nsaid');
    assert.equal(m('cotrimoxazole').allergyGroup, 'sulfa');
    assert.equal(m('piperacillin-tazobactam').allergyGroup, 'penicillin');
    assert.equal(m('aspirin').allergyGroup, 'aspirin');
    assert.equal(m('ceftriaxone').allergyGroup, undefined);
    assert.equal(m('ticagrelor').classKey, 'antiplatelet-p2y12');
    assert.equal(m('warfarin').classLabel, 'Anticoagulant (vitamin K antagonist)');
    assert.equal(m('ringer-lactate').classKey, 'iv-fluid');
    assert.deepEqual(m('furosemide').aliases, ['frusemide']);
  });

  test('product keys, labels, routes and vial content', () => {
    assert.equal(product('aspirin-tab-300').label, 'Aspirin tab 300 mg');
    assert.equal(product('ramipril-cap-2.5').label, 'Ramipril cap 2.5 mg');
    assert.equal(product('isosorbide-dinitrate-sl-tab-5').routes[0], 'sublingual');
    assert.equal(product('heparin-mdv-25000').contentPerVial, 25000);
    assert.equal(product('insulin-regular-mdv-1000').contentPerVial, 1000);
    assert.deepEqual(product('insulin-regular-mdv-1000').routes, ['sc', 'iv']);
    assert.deepEqual(product('ceftriaxone-vial-1').routes, ['iv', 'im']);
    assert.deepEqual(product('morphine-ampoule-10').routes, ['iv', 'im', 'sc']);
    assert.deepEqual(product('adrenaline-ampoule-1').routes, ['im', 'iv']);
    assert.deepEqual(product('potassium-chloride-ampoule-20').routes, ['iv']);
    assert.deepEqual(product('furosemide-ampoule-20').routes, ['iv', 'im']);
    assert.equal(product('paracetamol-bottle-1000').issueUnit, 'bottle');
    assert.equal(product('normal-saline-bag-500').label, 'Normal saline 0.9% IV bag 500 mL');
  });

  test('sameKind lists the other medicines of the class', () => {
    assert.deepEqual(sameKind('ibuprofen'), ['diclofenac']);
    assert.deepEqual(sameKind('clopidogrel'), ['ticagrelor']);
    assert.deepEqual(sameKind('nope'), []);
  });
});

describe('quantity', () => {
  test('examples', () => {
    assert.equal(quantityFor(product('clopidogrel-tab-75'), 300, 'STAT', null), 4);
    assert.equal(quantityFor(product('enoxaparin-syringe-60'), 60, 'BD', 5), 10);
    assert.equal(quantityFor(product('heparin-mdv-25000'), 5000, 'BD', 5), 2);
    assert.equal(quantityFor(product('insulin-regular-mdv-1000'), 10, 'TDS', 3), 1);
    assert.equal(quantityFor(product('paracetamol-tab-500'), 500, 'SOS', 3), 12);
  });
  test('duration null gives null, except STAT', () => {
    assert.equal(quantityFor(product('paracetamol-tab-500'), 500, 'BD', null), null);
    assert.equal(quantityFor(product('aspirin-tab-300'), 300, 'STAT', null), 1);
  });
});

describe('matchMedicine', () => {
  const key = (t: string) => matchMedicine(t)?.key ?? null;
  test('typed names', () => {
    assert.equal(key('Tab Amlodipine 5 mg'), 'amlodipine');
    assert.equal(key('Augmentin 625'), 'amoxicillin-clavulanate');
    assert.equal(key('Amoxicillin'), 'amoxicillin');
    assert.equal(key('Inj. Ceftriaxone 1g'), 'ceftriaxone');
    assert.equal(key('Normal Saline 0.9%'), 'normal-saline');
    assert.equal(key('Co-amoxiclav'), 'amoxicillin-clavulanate');
    assert.equal(key('Tab. Frusemide 40mg'), 'furosemide');
    assert.equal(key("Ringer's Lactate"), 'ringer-lactate');
  });
  test('exact only: Levocetirizine is not cetirizine', () => {
    assert.equal(key('Syp Levocetirizine'), null);
    assert.equal(key('Levocetirizine'), null);
    assert.equal(key('Paracetamol and codeine'), null);
    assert.equal(key(''), null);
  });
});

describe('parseDose and parseDurationDays', () => {
  test('dose', () => {
    assert.deepEqual(parseDose('500 mg'), { value: 500, unit: 'mg' });
    assert.deepEqual(parseDose('5 ml'), { value: 5, unit: 'mL' });
    assert.deepEqual(parseDose('2.5mg'), { value: 2.5, unit: 'mg' });
    assert.deepEqual(parseDose('10 units'), { value: 10, unit: 'IU' });
    assert.equal(parseDose('1-0-1'), null);
    assert.equal(parseDose('500 mcg'), null);
  });
  test('duration', () => {
    assert.equal(parseDurationDays('30 days'), 30);
    assert.equal(parseDurationDays('2 weeks'), 14);
    assert.equal(parseDurationDays('1 day'), 1);
    assert.equal(parseDurationDays('Continue'), null);
    assert.equal(parseDurationDays('400 days'), null);
  });
});

describe('pickProduct and routeFor', () => {
  const med = (k: string) => medicineByKey(k)!;
  test('picks by route and dose', () => {
    assert.equal(pickProduct(med('paracetamol'), 1000, 'Oral').key, 'paracetamol-tab-500');
    assert.equal(pickProduct(med('paracetamol'), 1000, 'IV').key, 'paracetamol-bottle-1000');
    assert.equal(pickProduct(med('clopidogrel'), 300).key, 'clopidogrel-tab-75');
    assert.equal(pickProduct(med('amlodipine'), 5).key, 'amlodipine-tab-5');
    assert.equal(pickProduct(med('aspirin'), 7).key, 'aspirin-tab-75');
    assert.equal(pickProduct(med('aspirin'), null).key, 'aspirin-tab-75');
  });
  test('route words', () => {
    const p = product('ceftriaxone-vial-1');
    assert.equal(routeFor(p, 'IM'), 'im');
    assert.equal(routeFor(p, 'Oral'), 'iv');
    assert.equal(routeFor(p), 'iv');
  });
});

// Written out by hand from the global-constraints medicine table:
// key|unit|class key|class label|allergy|S|D|per kg|aliases|products (form:strengths;...)
const EXPECTED_TABLE = `
aspirin|mg|antiplatelet-salicylate|Antiplatelet (salicylate)|aspirin|600|4000||-|tab:75,150,300
clopidogrel|mg|antiplatelet-p2y12|Antiplatelet (P2Y12)|-|600|600||-|tab:75
ticagrelor|mg|antiplatelet-p2y12|Antiplatelet (P2Y12)|-|180|360||-|tab:90
enoxaparin|mg|anticoagulant-heparin|Anticoagulant (heparin)|-|150||1.1|-|syringe:40,60,80
heparin|IU|anticoagulant-heparin|Anticoagulant (heparin)|-|10000|40000||unfractionated heparin|mdv:25000
warfarin|mg|anticoagulant-vka|Anticoagulant (vitamin K antagonist)|-|10|||-|tab:1,2,5
atorvastatin|mg|statin|Statin|-||80||-|tab:10,20,40,80
rosuvastatin|mg|statin|Statin|-||40||-|tab:5,10,20,40
isosorbide-dinitrate|mg|nitrate|Nitrate|-|10|||isdn|sl-tab:5
metoprolol|mg|beta-blocker|Beta blocker|-||400||-|tab:25,50
ramipril|mg|ace-inhibitor|ACE inhibitor (RAAS)|-||10||-|cap:2.5,5,10
telmisartan|mg|arb|ARB (RAAS)|-||80||-|tab:40,80
amlodipine|mg|ccb|Calcium channel blocker|-||10||-|tab:5,10
furosemide|mg|loop-diuretic|Loop diuretic|-||600||frusemide|tab:40;ampoule:20
spironolactone|mg|k-sparing-diuretic|Potassium-sparing diuretic|-||100||-|tab:25,50
metformin|mg|biguanide|Biguanide|-||2550||-|tab:500,1000
glimepiride|mg|sulfonylurea|Sulfonylurea|-||8||-|tab:1,2
insulin-regular|IU|insulin|Insulin|-|50|||regular insulin,human insulin|mdv:1000
amoxicillin|mg|penicillin|Penicillin|penicillin||3000||amoxycillin|cap:500
amoxicillin-clavulanate|mg|penicillin|Penicillin|penicillin||1875||co-amoxiclav,augmentin|tab:625
piperacillin-tazobactam|g|penicillin|Penicillin|penicillin||18||pip-taz|vial:4.5
ceftriaxone|g|cephalosporin|Cephalosporin|-||4||-|vial:1
meropenem|g|carbapenem|Carbapenem|-||6||-|vial:1
azithromycin|mg|macrolide|Macrolide|-||500||-|tab:500
ciprofloxacin|mg|fluoroquinolone|Fluoroquinolone|-||1500||-|tab:500
metronidazole|mg|nitroimidazole|Nitroimidazole|-||2000||-|tab:400;bag:500
cotrimoxazole|mg|sulfonamide|Sulfonamide (sulfa)|sulfa||1920||co-trimoxazole,septran|tab:960
vancomycin|mg|glycopeptide|Glycopeptide|-|2000||20|-|vial:500,1000
paracetamol|mg|analgesic|Analgesic|-|1000|4000|15/50|acetaminophen|tab:500,650;bottle:1000
diclofenac|mg|nsaid|NSAID|nsaid||150||-|tab:50;ampoule:75
ibuprofen|mg|nsaid|NSAID|nsaid||2400||-|tab:400
tramadol|mg|opioid|Opioid|-||400||-|cap:50;ampoule:50
morphine|mg|opioid|Opioid|-|10|||-|ampoule:10
pantoprazole|mg|ppi|PPI|-||80||-|tab:40;vial:40
omeprazole|mg|ppi|PPI|-||40||-|cap:20
ondansetron|mg|antiemetic|Antiemetic|-|8|24||-|tab:4;ampoule:4
salbutamol|mg|bronchodilator|Bronchodilator|-|5|||albuterol|nebule:2.5
hydrocortisone|mg|steroid|Steroid|-||400||-|vial:100
adrenaline|mg|emergency|Emergency|-|1|||epinephrine|ampoule:1
levetiracetam|mg|antiepileptic|Antiepileptic|-||3000||-|tab:500;vial:500
cetirizine|mg|antihistamine|Antihistamine|-||10||-|tab:10
potassium-chloride|mmol|potassium|Potassium supplement|-|40|||kcl|sachet:20;ampoule:20
normal-saline|mL|iv-fluid|IV fluid|-||||ns,sodium chloride 0.9%|bag:500
ringer-lactate|mL|iv-fluid|IV fluid|-||||rl,ringer's lactate|bag:500
`
  .trim()
  .split('\n');

const EXPECTED_KIDNEY = `
enoxaparin|0|30|red|reduce to once daily
rosuvastatin|0|30|amber|max 10 mg
ramipril|0|30|amber|start low and check potassium
spironolactone|0|30|red|avoid: high potassium risk
metformin|0|30|red|avoid
metformin|30|45|amber|max 1000 mg a day
glimepiride|0|30|amber|low blood sugar risk; start low
amoxicillin-clavulanate|0|30|amber|reduce the dose
piperacillin-tazobactam|0|40|amber|reduce the dose
meropenem|0|50|amber|reduce the dose
ciprofloxacin|0|30|amber|reduce the dose
cotrimoxazole|0|30|amber|reduce the dose
vancomycin|0|50|amber|dose by blood levels
diclofenac|0|30|red|avoid
diclofenac|30|60|amber|use with care; check kidney function
ibuprofen|0|30|red|avoid
ibuprofen|30|60|amber|use with care; check kidney function
tramadol|0|30|amber|longer gap between doses
morphine|0|30|amber|reduce the dose
levetiracetam|0|50|amber|reduce the dose
`
  .trim()
  .split('\n');

describe('the whole table', () => {
  test('every medicine row matches the constraints', () => {
    const actual = MEDICINES.map((m) =>
      [
        m.key,
        m.unit,
        m.classKey,
        m.classLabel,
        m.allergyGroup ?? '-',
        m.maxSingle ?? '',
        m.maxDaily ?? '',
        m.perKg ? `${m.perKg.perKg}${m.perKg.underKg ? '/' + m.perKg.underKg : ''}` : '',
        m.aliases.length ? m.aliases.join(',') : '-',
        [...new Set(m.products.map((p) => p.form))]
          .map((f) => `${f}:${m.products.filter((p) => p.form === f).map((p) => p.strength).join(',')}`)
          .join(';'),
      ].join('|'),
    );
    assert.deepEqual(actual, EXPECTED_TABLE);
  });

  test('every kidney rule matches the constraints, with words', () => {
    const actual = MEDICINES.flatMap((m) =>
      m.kidney.map((k) => [m.key, k.from, k.below, k.severity, k.words].join('|')),
    );
    assert.deepEqual(actual, EXPECTED_KIDNEY);
  });
});
