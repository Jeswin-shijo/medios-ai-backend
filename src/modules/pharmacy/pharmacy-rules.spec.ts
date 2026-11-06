import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  CheckLine,
  Flag,
  FlagDraft,
  PatientFacts,
  checkLine,
  egfr,
  kidneyFlags,
  mergeFlags,
  nameChecks,
  needsDoctor,
  needsReason,
  needsReview,
  newRed,
} from './pharmacy-rules';

const patient = (over: Partial<PatientFacts> = {}): PatientFacts => ({
  age: 50,
  sex: 'M',
  weightKg: 70,
  allergies: [],
  egfr: 90,
  kidneyStatus: 'known',
  ...over,
});
const line = (medicine: string | null, over: Partial<CheckLine> = {}): CheckLine => ({
  medicine,
  dose: null,
  frequency: 'OD',
  ...over,
});
const keys = (f: FlagDraft[]) => f.map((x) => x.key);
const only = (f: FlagDraft[], key: string) => f.find((x) => x.key === key);

describe('allergy', () => {
  test('a penicillin allergy makes amoxicillin-clavulanate red', () => {
    const f = checkLine(line('amoxicillin-clavulanate'), patient({ allergies: ['Penicillin'] }), []);
    const a = only(f, 'allergy.amoxicillin-clavulanate')!;
    assert.equal(a.severity, 'red');
    assert.equal(a.kind, 'allergy');
    assert.equal(a.text, 'Penicillin allergy recorded: amoxicillin-clavulanate is a penicillin');
  });
  test('a name match says allergy recorded to the medicine', () => {
    const f = checkLine(line('ibuprofen'), patient({ allergies: ['Ibuprofen'] }), []);
    assert.equal(only(f, 'allergy.ibuprofen')!.text, 'Allergy recorded to ibuprofen');
  });
  test('group texts for sulfa and NSAID', () => {
    assert.equal(
      only(checkLine(line('cotrimoxazole'), patient({ allergies: ['Sulpha drugs'] }), []), 'allergy.cotrimoxazole')!.text,
      'Sulfa allergy recorded: cotrimoxazole is a sulfonamide',
    );
    assert.equal(
      only(checkLine(line('diclofenac'), patient({ allergies: ['NSAIDs'] }), []), 'allergy.diclofenac')!.text,
      'NSAID allergy recorded: diclofenac is an NSAID',
    );
  });
  test('cross-reactions are amber', () => {
    const cef = checkLine(line('ceftriaxone'), patient({ allergies: ['Penicillin'] }), []);
    assert.equal(only(cef, 'allergy.cross-penicillin')!.severity, 'amber');
    assert.equal(
      only(cef, 'allergy.cross-penicillin')!.text,
      'Penicillin allergy recorded: cross-reaction with ceftriaxone is uncommon; check what the reaction was',
    );
    const mero = checkLine(line('meropenem'), patient({ allergies: ['Penicillin'] }), []);
    assert.equal(only(mero, 'allergy.cross-penicillin')!.severity, 'amber');
    const asp = checkLine(line('aspirin'), patient({ allergies: ['NSAID'] }), []);
    assert.equal(only(asp, 'allergy.cross-nsaid')!.severity, 'amber');
    const ibu = checkLine(line('ibuprofen'), patient({ allergies: ['Aspirin'] }), []);
    assert.equal(only(ibu, 'allergy.cross-aspirin')!.severity, 'amber');
    assert.equal(keys(ibu).includes('allergy.ibuprofen'), false);
  });
  test('a red flag suppresses the amber cross-reaction', () => {
    const f = checkLine(line('aspirin'), patient({ allergies: ['NSAID', 'Aspirin'] }), []);
    assert.equal(only(f, 'allergy.aspirin')!.severity, 'red');
    assert.equal(only(f, 'allergy.cross-nsaid'), undefined);
  });
  test('free text: negations and look-alikes raise nothing; real allergies do', () => {
    const none = ['No known drug allergies', 'NKDA', 'Nil', 'None', 'Not known', 'Dust', 'Ferrous sulfate'];
    for (const a of none) {
      for (const m of ['amoxicillin', 'cotrimoxazole', 'ibuprofen', 'aspirin', 'ceftriaxone']) {
        const f = checkLine(line(m), patient({ allergies: [a] }), []);
        assert.equal(f.filter((x) => x.kind === 'allergy').length, 0, `${a} / ${m}`);
      }
    }
    assert.equal(
      checkLine(line('amoxicillin'), patient({ allergies: ['Penicillins'] }), []).filter((x) => x.severity === 'red').length,
      1,
    );
    assert.equal(
      checkLine(line('cotrimoxazole'), patient({ allergies: ['Sulpha drugs'] }), []).filter((x) => x.severity === 'red').length,
      1,
    );
  });
  test('a mixed list still matches the real entry', () => {
    const f = checkLine(line('amoxicillin'), patient({ allergies: ['No food allergies', 'Penicillin'] }), []);
    assert.equal(only(f, 'allergy.amoxicillin')!.severity, 'red');
  });
});

describe('clashes', () => {
  test('ibuprofen with an active enoxaparin is red', () => {
    const f = checkLine(line('ibuprofen'), patient(), [line('enoxaparin')]);
    const c = only(f, 'clash.enoxaparin')!;
    assert.equal(c.severity, 'red');
    assert.equal(c.text, 'Major bleeding risk (ibuprofen with enoxaparin)');
  });
  test('the text keeps the table orientation from either side', () => {
    const f = checkLine(line('enoxaparin'), patient(), [line('ibuprofen')]);
    const c = only(f, 'clash.ibuprofen')!;
    assert.equal(c.text, 'Major bleeding risk (ibuprofen with enoxaparin)');
  });
  test('enoxaparin with aspirin is amber', () => {
    const c = only(checkLine(line('enoxaparin'), patient(), [line('aspirin')]), 'clash.aspirin')!;
    assert.equal(c.severity, 'amber');
    assert.equal(c.text, 'Bleeding risk; usual in heart-attack care; monitor (enoxaparin with aspirin)');
  });
  test('aspirin with clopidogrel or ticagrelor raises nothing', () => {
    assert.deepEqual(checkLine(line('aspirin'), patient(), [line('clopidogrel')]), []);
    assert.deepEqual(checkLine(line('aspirin'), patient(), [line('ticagrelor')]), []);
  });
  test('warfarin with metronidazole is red', () => {
    const c = only(checkLine(line('warfarin'), patient(), [line('metronidazole')]), 'clash.metronidazole')!;
    assert.equal(c.severity, 'red');
    assert.equal(c.text, 'Raises INR sharply (warfarin with metronidazole)');
  });
  test('the remaining rows', () => {
    const t = (a: string, b: string) => checkLine(line(a), patient(), [line(b)]).find((f) => f.kind === 'clash');
    assert.equal(t('spironolactone', 'potassium-chloride')!.severity, 'red');
    assert.equal(t('ibuprofen', 'clopidogrel')!.text, 'Bleeding risk; consider paracetamol (ibuprofen with clopidogrel)');
    assert.equal(t('warfarin', 'ciprofloxacin')!.severity, 'amber');
    assert.equal(t('clopidogrel', 'omeprazole')!.text, 'Omeprazole weakens clopidogrel; pantoprazole is preferred (clopidogrel with omeprazole)');
    assert.equal(t('ramipril', 'spironolactone')!.text, 'High potassium risk; check potassium (ramipril with spironolactone)');
    assert.equal(t('telmisartan', 'potassium-chloride')!.severity, 'amber');
    assert.equal(t('ondansetron', 'azithromycin')!.text, 'QT prolongation risk (ondansetron with azithromycin)');
    assert.equal(t('amlodipine', 'metoprolol'), undefined);
  });
  test('every row of the table, on its own', () => {
    const rows: Array<[string, string, string, string]> = [
      ['ibuprofen', 'heparin', 'red', 'Major bleeding risk'],
      ['diclofenac', 'warfarin', 'red', 'Major bleeding risk'],
      ['warfarin', 'metronidazole', 'red', 'Raises INR sharply'],
      ['warfarin', 'cotrimoxazole', 'red', 'Raises INR sharply'],
      ['spironolactone', 'potassium-chloride', 'red', 'High potassium risk'],
      ['diclofenac', 'aspirin', 'amber', 'Bleeding risk; consider paracetamol'],
      ['ibuprofen', 'ticagrelor', 'amber', 'Bleeding risk; consider paracetamol'],
      ['heparin', 'clopidogrel', 'amber', 'Bleeding risk; usual in heart-attack care; monitor'],
      ['warfarin', 'aspirin', 'amber', 'Bleeding risk; usual in heart-attack care; monitor'],
      ['warfarin', 'ciprofloxacin', 'amber', 'May raise INR; check INR'],
      ['warfarin', 'azithromycin', 'amber', 'May raise INR; check INR'],
      ['clopidogrel', 'omeprazole', 'amber', 'Omeprazole weakens clopidogrel; pantoprazole is preferred'],
      ['ramipril', 'spironolactone', 'amber', 'High potassium risk; check potassium'],
      ['ramipril', 'potassium-chloride', 'amber', 'High potassium risk; check potassium'],
      ['telmisartan', 'spironolactone', 'amber', 'High potassium risk; check potassium'],
      ['telmisartan', 'potassium-chloride', 'amber', 'High potassium risk; check potassium'],
      ['ondansetron', 'azithromycin', 'amber', 'QT prolongation risk'],
      ['ondansetron', 'ciprofloxacin', 'amber', 'QT prolongation risk'],
    ];
    for (const [l, r, sev, words] of rows) {
      for (const [a, b] of [[l, r], [r, l]]) {
        const f = checkLine(line(a), patient(), [line(b)]).filter((x) => x.kind === 'clash');
        assert.equal(f.length, 1, `${a} / ${b}`);
        assert.equal(f[0].severity, sev, `${a} / ${b}`);
        assert.equal(f[0].text, `${words} (${l} with ${r})`);
        assert.equal(f[0].key, `clash.${b}`);
      }
    }
  });
  test('an unlisted other line is ignored', () => {
    assert.deepEqual(checkLine(line('aspirin'), patient(), [line(null)]), []);
  });
});

describe('doubles', () => {
  const dbl = (a: string, b: string) =>
    checkLine(line(a), patient(), [line(b)]).find((f) => f.kind === 'double');
  test('class doubles', () => {
    assert.equal(dbl('clopidogrel', 'ticagrelor')!.severity, 'red');
    assert.equal(dbl('clopidogrel', 'ticagrelor')!.text, 'Two P2Y12 antiplatelets (clopidogrel with ticagrelor)');
    assert.equal(dbl('ramipril', 'telmisartan')!.severity, 'red');
    assert.equal(dbl('telmisartan', 'ramipril')!.text, 'ACE inhibitor with ARB (ramipril with telmisartan)');
    assert.equal(dbl('atorvastatin', 'rosuvastatin')!.severity, 'amber');
    assert.equal(dbl('omeprazole', 'pantoprazole')!.text, 'Two PPIs (omeprazole with pantoprazole)');
    assert.equal(dbl('enoxaparin', 'heparin')!.text, 'Two heparins (enoxaparin with heparin)');
    assert.equal(dbl('tramadol', 'morphine')!.severity, 'red');
    assert.equal(dbl('ibuprofen', 'diclofenac')!.text, 'Two NSAIDs (ibuprofen with diclofenac)');
  });
  test('warfarin with a heparin is an amber bridge, from either side', () => {
    const d1 = dbl('warfarin', 'enoxaparin')!;
    assert.equal(d1.severity, 'amber');
    assert.equal(d1.text, 'Bridging: confirm intended (warfarin with enoxaparin)');
    assert.equal(dbl('enoxaparin', 'warfarin')!.text, d1.text);
  });
  test('the same medicine twice wins over a class double', () => {
    const f = checkLine(line('aspirin'), patient(), [line('aspirin')]);
    assert.equal(f.length, 1);
    assert.equal(f[0].key, 'double.aspirin');
    assert.equal(f[0].severity, 'red');
    assert.equal(f[0].text, 'Same medicine twice (aspirin)');
  });
  test('different classes make no double', () => {
    assert.equal(dbl('amlodipine', 'metoprolol'), undefined);
    assert.equal(dbl('ceftriaxone', 'meropenem'), undefined);
  });
});

describe('a take-home line continuing a ward medicine (A12)', () => {
  const ward = (over: Partial<CheckLine> = {}) => line('enoxaparin', { caseId: 'c1', setting: 'Ward', takeHome: false, ...over });
  const home = (over: Partial<CheckLine> = {}) => line('enoxaparin', { caseId: 'c1', setting: 'Ward', takeHome: true, ...over });
  const pair = (a: CheckLine, b: CheckLine) =>
    checkLine(a, patient(), [b]).filter((f) => f.kind === 'double' || f.kind === 'continues').map((f) => [f.key, f.kind, f.severity, f.text]);
  const NOTE = [['continues.enoxaparin', 'continues', 'info', 'Continues ward medicine']];
  const RED = [['double.enoxaparin', 'double', 'red', 'Same medicine twice (enoxaparin)']];

  test('a take-home line and a Ward or ER line of the same case and medicine: an info note, from either side', () => {
    assert.deepEqual(pair(home(), ward()), NOTE);
    assert.deepEqual(pair(ward(), home()), NOTE);
    assert.deepEqual(pair(home(), ward({ setting: 'ER' })), NOTE);
    assert.deepEqual(pair(ward({ setting: 'ER' }), home()), NOTE);
  });
  test('anything else is still the red "Same medicine twice"', () => {
    assert.deepEqual(pair(home(), home()), RED, 'two take-home lines');
    assert.deepEqual(pair(home(), ward({ setting: 'OPD' })), RED, 'an OPD counter line');
    assert.deepEqual(pair(ward({ setting: 'OPD' }), home()), RED, 'an OPD counter line, other side');
    assert.deepEqual(pair(home(), ward({ caseId: 'c2' })), RED, 'another case');
    assert.deepEqual(pair(home({ caseId: undefined }), ward({ caseId: undefined })), RED, 'no case known');
    assert.deepEqual(pair(home(), ward({ setting: undefined })), RED, 'no setting known');
    assert.deepEqual(pair(ward(), ward({ setting: 'ER' })), RED, 'two ward lines');
    assert.deepEqual(pair(line('enoxaparin'), line('enoxaparin')), RED, 'no context at all');
  });
  test('class doubles still apply to a take-home line', () => {
    const ctx = { caseId: 'c1', setting: 'Ward' as const };
    assert.deepEqual(pair(line('omeprazole', { ...ctx, takeHome: true }), line('pantoprazole', ctx)), [
      ['double.pantoprazole', 'double', 'amber', 'Two PPIs (omeprazole with pantoprazole)'],
    ]);
    assert.deepEqual(pair(home(), line('heparin', ctx)), [['double.heparin', 'double', 'red', 'Two heparins (enoxaparin with heparin)']]);
  });
  test('an info flag is never a gate and never a new red', () => {
    const info: Flag = { key: 'continues.enoxaparin', kind: 'continues', severity: 'info', text: 'Continues ward medicine', version: 1 };
    assert.deepEqual([needsDoctor([info], 1), needsReason([info], 1), needsReview([info], 1), newRed([], [info])], [[], [], [], []]);
  });
});

describe('dose', () => {
  test('aspirin 900 mg is a red single dose', () => {
    const f = checkLine(line('aspirin', { dose: 900, frequency: 'STAT' }), patient(), []);
    assert.equal(only(f, 'dose.single')!.text, 'Single dose 900 mg is above the 600 mg maximum');
    assert.equal(only(f, 'dose.single')!.severity, 'red');
  });
  test('ibuprofen 800 mg QID is a red daily total; TDS is not', () => {
    const q = checkLine(line('ibuprofen', { dose: 800, frequency: 'QID' }), patient(), []);
    assert.equal(only(q, 'dose.daily')!.text, 'Daily total 3200 mg is above the 2400 mg maximum');
    const t = checkLine(line('ibuprofen', { dose: 800, frequency: 'TDS' }), patient(), []);
    assert.equal(only(t, 'dose.daily'), undefined);
  });
  test('SOS counts four doses; STAT counts one', () => {
    const ibu = (dose: number) =>
      checkLine(line('ibuprofen', { dose, frequency: 'SOS' }), patient(), []);
    assert.equal(only(ibu(600), 'dose.daily'), undefined); // 2400, not above
    assert.equal(only(ibu(650), 'dose.daily')!.text, 'Daily total 2600 mg is above the 2400 mg maximum');
    const heparin = checkLine(line('heparin', { dose: 10000, frequency: 'QID' }), patient(), []);
    assert.equal(only(heparin, 'dose.daily'), undefined);
    const heparin2 = checkLine(line('heparin', { dose: 10001, frequency: 'STAT' }), patient(), []);
    assert.equal(keys(heparin2).join(), 'dose.single');
  });
  test('no weight: paracetamol raises no flag; vancomycin and enoxaparin do (Y19)', () => {
    const para = checkLine(line('paracetamol', { dose: 1000, frequency: 'BD' }), patient({ weightKg: null }), []);
    assert.deepEqual(para, []);
    const vanc = checkLine(line('vancomycin', { dose: 1000, frequency: 'BD' }), patient({ weightKg: null }), []);
    assert.deepEqual(keys(vanc), ['dose.no-weight']);
  });
  test('a weight of 0 or less counts as not recorded', () => {
    for (const w of [0, -5]) {
      const enox = checkLine(line('enoxaparin', { dose: 60, frequency: 'BD' }), patient({ weightKg: w }), []);
      assert.deepEqual(keys(enox), ['dose.no-weight']);
      assert.deepEqual(checkLine(line('paracetamol', { dose: 1000, frequency: 'BD' }), patient({ weightKg: w }), []), []);
    }
  });
  test('enoxaparin 80 mg at 60 kg is an amber per-kg flag', () => {
    const f = checkLine(line('enoxaparin', { dose: 80, frequency: 'BD' }), patient({ weightKg: 60 }), []);
    const p = only(f, 'dose.per-kg')!;
    assert.equal(p.severity, 'amber');
    assert.equal(p.text, '80 mg is above 1.1 mg/kg for 60 kg (66 mg)');
    assert.equal(only(checkLine(line('enoxaparin', { dose: 60, frequency: 'BD' }), patient({ weightKg: 60 }), []), 'dose.per-kg'), undefined);
  });
  test('enoxaparin with no weight is amber Weight not recorded', () => {
    const f = checkLine(line('enoxaparin', { dose: 60, frequency: 'BD' }), patient({ weightKg: null }), []);
    assert.equal(only(f, 'dose.no-weight')!.text, 'Weight not recorded');
    assert.equal(only(f, 'dose.no-weight')!.severity, 'amber');
  });
  test('paracetamol 1000 mg at 45 kg is amber per-kg; at 60 kg nothing', () => {
    const low = checkLine(line('paracetamol', { dose: 1000, frequency: 'BD' }), patient({ weightKg: 45 }), []);
    assert.equal(only(low, 'dose.per-kg')!.text, '1000 mg is above 15 mg/kg for 45 kg (675 mg)');
    const ok = checkLine(line('paracetamol', { dose: 1000, frequency: 'BD' }), patient({ weightKg: 60 }), []);
    assert.deepEqual(ok, []);
  });
  test('vancomycin uses 20 mg/kg with no weight cap', () => {
    const f = checkLine(line('vancomycin', { dose: 2000, frequency: 'BD' }), patient({ weightKg: 70 }), []);
    assert.equal(only(f, 'dose.per-kg')!.text, '2000 mg is above 20 mg/kg for 70 kg (1400 mg)');
  });
  test('a dose at the maximum is fine; fluids have no limit', () => {
    assert.deepEqual(checkLine(line('aspirin', { dose: 600, frequency: 'STAT' }), patient(), []), []);
    assert.deepEqual(checkLine(line('normal-saline', { dose: 5000, frequency: 'QID' }), patient(), []), []);
  });
});

describe('egfr', () => {
  test('examples', () => {
    assert.equal(egfr({ creatinine: 2.5, sex: 'M', age: 62 }), 28);
    assert.equal(egfr({ creatinine: 2.5, sex: 'M', age: 52 }), 30);
    assert.equal(egfr({ creatinine: 0.6, sex: 'F', age: 40 }), 116);
    assert.equal(egfr({ creatinine: 1.4, sex: 'F', age: 70 }), 40);
    assert.equal(egfr({ creatinine: 2.5, sex: 'Other', age: 62 }), 21);
  });
  test('null for a child, or missing age, sex or creatinine', () => {
    assert.equal(egfr({ creatinine: 1, sex: 'M', age: 15 }), null);
    assert.equal(egfr({ creatinine: 1, sex: 'M', age: null }), null);
    assert.equal(egfr({ creatinine: 1, sex: null, age: 40 }), null);
    assert.equal(egfr({ creatinine: 0, sex: 'M', age: 40 }), null);
    assert.equal(egfr({ creatinine: NaN, sex: 'M', age: 40 }), null);
  });
});

describe('kidney', () => {
  const k = (med: string, e: number | null, status: PatientFacts['kidneyStatus'] = 'known') =>
    kidneyFlags(line(med), patient({ egfr: e, kidneyStatus: status }));
  test('eGFR 28: enoxaparin is red', () => {
    const f = k('enoxaparin', 28);
    assert.equal(f.length, 1);
    assert.equal(f[0].key, 'kidney.0-30');
    assert.equal(f[0].severity, 'red');
    assert.equal(f[0].text, 'eGFR 28: enoxaparin, reduce to once daily');
  });
  test('the bands are from-inclusive and below-exclusive', () => {
    assert.deepEqual(k('enoxaparin', 30), []);
    assert.equal(k('metformin', 29)[0].severity, 'red');
    const m30 = k('metformin', 30)[0];
    assert.equal(m30.key, 'kidney.30-45');
    assert.equal(m30.severity, 'amber');
    assert.equal(k('metformin', 40)[0].text, 'eGFR 40: metformin, max 1000 mg a day');
    assert.deepEqual(k('metformin', 45), []);
    assert.equal(k('meropenem', 49)[0].key, 'kidney.0-50');
    assert.deepEqual(k('meropenem', 50), []);
    assert.equal(k('ibuprofen', 59)[0].key, 'kidney.30-60');
    assert.equal(k('amoxicillin-clavulanate', 10)[0].text, 'eGFR 10: amoxicillin-clavulanate, reduce the dose');
  });
  test('no recent result is amber unknown', () => {
    const f = k('enoxaparin', null, 'unknown');
    assert.equal(f[0].key, 'kidney.unknown');
    assert.equal(f[0].severity, 'amber');
    assert.equal(f[0].text, 'Kidney function not known: recheck when creatinine arrives');
  });
  test('not-calculated raises no kidney flag (Y11)', () => {
    assert.deepEqual(k('enoxaparin', null, 'not-calculated'), []);
    assert.deepEqual(k('metformin', 20, 'not-calculated'), []);
  });
  test('medicines with no kidney rule never get one', () => {
    assert.deepEqual(k('aspirin', 10), []);
    assert.deepEqual(k('aspirin', null, 'unknown'), []);
    assert.deepEqual(kidneyFlags(line(null), patient({ egfr: 10 })), []);
  });
  test('checkLine includes kidney flags', () => {
    const f = checkLine(line('enoxaparin', { dose: 40, frequency: 'OD' }), patient({ egfr: 25 }), []);
    assert.deepEqual(keys(f), ['kidney.0-30']);
  });
});

describe('age and list', () => {
  test('a 12-year-old gets one amber age.child per line', () => {
    const f = checkLine(line('amlodipine', { dose: 5 }), patient({ age: 12, kidneyStatus: 'not-calculated', egfr: null }), []);
    assert.deepEqual(keys(f), ['age.child']);
    assert.equal(f[0].severity, 'amber');
    assert.equal(f[0].text, 'Child: these dose rules are for adults; check the dose');
    assert.deepEqual(keys(checkLine(line('amlodipine'), patient({ age: 18 }), [])), []);
  });
  test('an unlisted line gets only list.unmatched', () => {
    const f = checkLine(line(null, { dose: 5000 }), patient({ age: 5, allergies: ['Penicillin'] }), [line('aspirin')]);
    assert.deepEqual(f, [
      { key: 'list.unmatched', kind: 'list', severity: 'amber', text: 'Not in the medicine list: checks could not run' },
    ]);
  });
  test('an unreadable dose gets list.dose-unreadable and no dose flag', () => {
    const f = checkLine(line('aspirin', { dose: 9000, frequency: 'QID', doseReadable: false }), patient(), []);
    assert.deepEqual(f, [
      { key: 'list.dose-unreadable', kind: 'list', severity: 'amber', text: 'Dose not readable: check by hand' },
    ]);
    const kid = checkLine(line('enoxaparin', { dose: null, doseReadable: false }), patient({ weightKg: null }), []);
    assert.deepEqual(keys(kid), ['list.dose-unreadable']);
  });
  test('rule order: allergy, clash, double, dose, kidney, age', () => {
    const f = checkLine(
      line('ibuprofen', { dose: 800, frequency: 'QID' }),
      patient({ age: 10, egfr: 20, allergies: ['Ibuprofen'] }),
      [line('enoxaparin'), line('diclofenac')],
    );
    assert.deepEqual(keys(f), [
      'allergy.ibuprofen',
      'clash.enoxaparin',
      'double.diclofenac',
      'dose.daily',
      'kidney.0-30',
      'age.child',
    ]);
  });
});

describe('mergeFlags and gates', () => {
  const at = new Date('2026-09-26T10:00:00Z');
  const flag = (key: string, kind: Flag['kind'], severity: Flag['severity'], version: number, extra: Partial<Flag> = {}): Flag => ({
    key, kind, severity, text: key, version, ...extra,
  });
  const draft = (key: string, kind: FlagDraft['kind'], severity: FlagDraft['severity'] = 'red'): FlagDraft => ({
    key, kind, severity, text: key,
  });

  test('keeps a confirmation for the same key and version', () => {
    const conf = { by: 'u1', reason: 'ok', at };
    const out = mergeFlags([flag('clash.x', 'clash', 'red', 2, { confirmed: conf })], [draft('clash.x', 'clash')], 2);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].confirmed, conf);
    assert.equal(out[0].version, 2);
  });
  test('keeps a review for the same key and version', () => {
    const rev = { by: 'u1', at };
    const out = mergeFlags([flag('allergy.cross-nsaid', 'allergy', 'amber', 1, { reviewed: rev })], [draft('allergy.cross-nsaid', 'allergy', 'amber')], 1);
    assert.deepEqual(out[0].reviewed, rev);
  });
  test('drops a confirmation for a new version', () => {
    const conf = { by: 'u1', reason: 'ok', at };
    const out = mergeFlags([flag('clash.x', 'clash', 'red', 1, { confirmed: conf })], [draft('clash.x', 'clash')], 2);
    assert.equal(out[0].confirmed, undefined);
    assert.equal(out[0].version, 2);
  });
  test('removes flags no longer raised', () => {
    const out = mergeFlags([flag('clash.x', 'clash', 'red', 1), flag('dose.single', 'dose', 'red', 1)], [draft('dose.single', 'dose')], 1);
    assert.deepEqual(out.map((f) => f.key), ['dose.single']);
  });
  test("with onlyKinds ['kidney'] leaves other kinds alone", () => {
    const existing = [
      flag('clash.x', 'clash', 'red', 1),
      flag('kidney.0-30', 'kidney', 'red', 1),
      flag('kidney.unknown', 'kidney', 'amber', 1),
    ];
    const out = mergeFlags(existing, [draft('kidney.30-45', 'kidney', 'amber'), draft('dose.single', 'dose')], 1, ['kidney']);
    assert.deepEqual(out.map((f) => f.key).sort(), ['clash.x', 'kidney.30-45']);
  });
  test('newRed lists red keys the line did not carry', () => {
    const before = [flag('a', 'clash', 'red', 1), flag('b', 'clash', 'amber', 1)];
    const after = [flag('a', 'clash', 'red', 1), flag('b', 'clash', 'red', 1), flag('c', 'dose', 'red', 1), flag('d', 'dose', 'amber', 1)];
    assert.deepEqual(newRed(before, after).map((f) => f.key), ['b', 'c']);
  });
  test('gates', () => {
    const conf = { by: 'u', reason: 'r', at };
    const flags = [
      flag('allergy.a', 'allergy', 'red', 2),
      flag('allergy.b', 'allergy', 'red', 2, { confirmed: conf }),
      flag('allergy.c', 'allergy', 'red', 1, { confirmed: conf }),
      flag('clash.x', 'clash', 'red', 2),
      flag('dose.single', 'dose', 'red', 2, { confirmed: conf }),
      flag('allergy.cross-nsaid', 'allergy', 'amber', 2),
      flag('allergy.cross-aspirin', 'allergy', 'amber', 2, { reviewed: { by: 'u', at } }),
      flag('clash.y', 'clash', 'amber', 2),
    ];
    assert.deepEqual(needsDoctor(flags, 2).map((f) => f.key), ['allergy.a', 'allergy.c']);
    assert.deepEqual(needsReason(flags, 2).map((f) => f.key), ['clash.x']);
    assert.deepEqual(needsReview(flags, 2).map((f) => f.key), ['allergy.cross-nsaid']);
  });
});

describe('nameChecks', () => {
  test('warfarin with metronidazole is one red flag', () => {
    const f = nameChecks(['Tab Warfarin 5 mg', 'Tab Metronidazole 400 mg']);
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, 'red');
    assert.equal(f[0].text, 'Raises INR sharply (warfarin with metronidazole)');
  });
  test('the order of names does not matter', () => {
    const f = nameChecks(['Tab Metronidazole 400 mg', 'Tab Warfarin 5 mg']);
    assert.equal(f.length, 1);
    assert.equal(f[0].text, 'Raises INR sharply (warfarin with metronidazole)');
  });
  test('one flag per key', () => {
    const a = nameChecks(['Ibuprofen', 'Diclofenac', 'Enoxaparin']).map((f) => f.key);
    assert.equal(new Set(a).size, a.length);
    const b = nameChecks(['Aspirin', 'Aspirin 75', 'Tab Aspirin']).map((f) => f.key);
    assert.deepEqual(b, ['double.aspirin']);
  });
  test('unknown names are skipped; doubles are found', () => {
    assert.deepEqual(nameChecks(['Syp Levocetirizine', 'Tab Aspirin 75']), []);
    const f = nameChecks(['Tab Aspirin 75', 'Aspirin 150 mg', 'Tab Clopidogrel']);
    assert.deepEqual(f.map((x) => x.key), ['double.aspirin']);
  });
});
