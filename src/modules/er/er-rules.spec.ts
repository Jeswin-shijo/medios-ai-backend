import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  BED_PRIORITY,
  COLOUR_RANK,
  COMPLAINTS,
  DOCTOR_TARGET_MIN,
  PATHWAYS,
  doctorDueMinutes,
  pathwayTargets,
  pathwaysFor,
  suggestTriage,
} from './er-rules';

describe('er-rules', () => {
  test('each red-flag vital gives red', () => {
    const cases: [Record<string, number>, string][] = [
      [{ spo2: 89 }, 'SpO₂ 89% (under 90%)'],
      [{ bpSystolic: 85 }, 'Systolic BP 85 (under 90)'],
      [{ heartRate: 135 }, 'Heart rate 135 (over 130)'],
      [{ heartRate: 38 }, 'Heart rate 38 (under 40)'],
      [{ respiratoryRate: 32 }, 'Respiratory rate 32 (over 30)'],
      [{ respiratoryRate: 6 }, 'Respiratory rate 6 (under 8)'],
    ];
    for (const [vitals, reason] of cases) {
      const r = suggestTriage({ complaint: 'other', vitals });
      assert.equal(r.colour, 'red', JSON.stringify(vitals));
      assert.ok(r.reasons.includes(reason), `${reason} in ${r.reasons.join('|')}`);
    }
  });

  test('chest pain is orange and starts the chest-pain pathway; with sweating it is red', () => {
    const plain = suggestTriage({ complaint: 'chest-pain', vitals: {} });
    assert.equal(plain.colour, 'orange');
    assert.ok(plain.reasons.includes('Complaint: chest pain'));
    assert.deepEqual(pathwaysFor('chest-pain', {}), ['chest-pain']);
    const severe = suggestTriage({ complaint: 'chest-pain-severe', vitals: {} });
    assert.equal(severe.colour, 'red');
    assert.deepEqual(pathwaysFor('chest-pain-severe', {}), ['chest-pain']);
    assert.deepEqual(pathwaysFor('stroke-signs', {}), ['stroke']);
  });

  test('fever with a fast pulse suggests sepsis', () => {
    const vitals = { temperature: 39.2, heartRate: 118 };
    const r = suggestTriage({ complaint: 'fever', vitals });
    assert.equal(r.colour, 'orange');
    assert.ok(r.reasons.includes('Temperature 39.2 °C with heart rate 118 (sepsis signs)'));
    assert.deepEqual(pathwaysFor('fever', vitals), ['sepsis']);
    assert.deepEqual(pathwaysFor('fever', { temperature: 39.2, heartRate: 110 }), []);
  });

  test('the highest colour wins and every reason is listed', () => {
    const r = suggestTriage({
      complaint: 'chest-pain',
      vitals: { spo2: 88, heartRate: 105, bpSystolic: 205 },
      painScore: 8,
    });
    assert.equal(r.colour, 'red');
    assert.deepEqual(r.reasons, [
      'SpO₂ 88% (under 90%)',
      'Complaint: chest pain',
      'Systolic BP 205 (over 200)',
      'Pain 8/10',
      'Heart rate 105 (over 100)',
    ]);
  });

  test('no vitals and a minor complaint gives green with "Vitals not recorded"', () => {
    const r = suggestTriage({ complaint: 'other', vitals: {} });
    assert.equal(r.colour, 'green');
    assert.deepEqual(r.reasons, ['No red flags', 'Vitals not recorded']);
    const withVitals = suggestTriage({ complaint: 'other', vitals: { spo2: 98, heartRate: 80 } });
    assert.deepEqual(withVitals.reasons, ['No red flags']);
  });

  test('vitals boundaries are contiguous and decimals work', () => {
    const c = (vitals: Record<string, number>) => suggestTriage({ complaint: 'other', vitals }).colour;
    assert.equal(c({ heartRate: 40 }), 'yellow');
    assert.equal(c({ heartRate: 50 }), 'yellow');
    assert.equal(c({ heartRate: 51 }), 'green');
    assert.equal(c({ bpSystolic: 90 }), 'yellow');
    assert.equal(c({ bpSystolic: 100.5 }), 'green');
    assert.equal(c({ bpSystolic: 160.5 }), 'yellow');
    assert.equal(c({ spo2: 93.5 }), 'orange');
    assert.equal(c({ spo2: 94 }), 'yellow');
    assert.equal(c({ spo2: 95.5 }), 'yellow');
    assert.equal(c({ spo2: 96 }), 'green');
    assert.equal(c({ respiratoryRate: 20.5 }), 'yellow');
    assert.equal(c({ temperature: 38 }), 'yellow');
    assert.equal(suggestTriage({ complaint: 'other', vitals: {}, painScore: 4 }).colour, 'yellow');
    assert.equal(suggestTriage({ complaint: 'other', vitals: {}, painScore: 7 }).colour, 'orange');
    assert.equal(suggestTriage({ complaint: 'other', vitals: {}, painScore: 3 }).colour, 'green');
  });

  test('complaint colours', () => {
    const c = (complaint: Parameters<typeof suggestTriage>[0]['complaint']) =>
      suggestTriage({ complaint, vitals: {} }).colour;
    assert.equal(c('unresponsive'), 'red');
    assert.equal(c('stroke-signs'), 'orange');
    assert.equal(c('fever'), 'yellow');
    assert.equal(c('head-injury'), 'green');
    assert.equal(COMPLAINTS.length, 14);
  });

  test('constants', () => {
    assert.equal(COLOUR_RANK.red, 0);
    assert.equal(COLOUR_RANK.green, 3);
    assert.equal(BED_PRIORITY.orange, 'high');
    assert.deepEqual(DOCTOR_TARGET_MIN, { red: 10, orange: 30, yellow: 120, green: 240 });
    assert.equal(PATHWAYS.sepsis.steps.length, 3);
  });

  test('doctorDueMinutes takes the earlier of colour and pathway', () => {
    const targets = pathwayTargets();
    assert.equal(doctorDueMinutes('orange', ['chest-pain'], targets), 15);
    assert.equal(doctorDueMinutes('red', ['chest-pain'], targets), 10);
    assert.equal(doctorDueMinutes('yellow', [], targets), 120);
    assert.equal(doctorDueMinutes('orange', ['stroke'], { ...targets, 'stroke.doctor': 5 }), 5);
    assert.equal(doctorDueMinutes('green', ['sepsis'], {}), 15);
  });

  test('pathwayTargets ignores unknown keys and out-of-range values', () => {
    const t = pathwayTargets({
      'stroke.doctor': 8,
      'stroke.nope': 5,
      doctor: 3,
      'chest-pain.ecg': 0,
      'sepsis.doctor': 241,
      'sepsis.cultures': 12.5,
      'sepsis.antibiotics': '30',
    });
    assert.equal(t['stroke.doctor'], 8);
    assert.equal(t['stroke.nope'], undefined);
    assert.equal(t['doctor'], undefined);
    assert.equal(t['chest-pain.ecg'], 10);
    assert.equal(t['sepsis.doctor'], 15);
    assert.equal(t['sepsis.cultures'], 45);
    assert.equal(t['sepsis.antibiotics'], 60);
    assert.equal(Object.keys(t).length, 8);
  });
});
