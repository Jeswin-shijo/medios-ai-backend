import * as assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  autoAssignable,
  autoClasses,
  isStepDown,
  nearestOptionText,
  splitExtraNeeds,
} from './agent-policy';
import { AdmissionRequestInput, BedInfo, WardInfo, WardType } from './bed-types';
import { RankedBed } from './scoring';

const ward = (type: WardType, ratePerDay: number): WardInfo => ({
  id: type,
  code: type,
  name: type,
  shortName: type,
  floor: 1,
  type,
  gender: 'any',
  ratePerDay,
  nearDepartments: [],
});
const wards: WardInfo[] = [
  ward('general', 800),
  ward('twin', 1500),
  ward('hdu', 4000),
  ward('icu', 7500),
];
const bed = (type: WardType): BedInfo => ({
  id: `${type}-1`,
  wardId: type,
  label: `${type} 1`,
  number: 1,
  features: [],
  state: 'free',
});
const beds: BedInfo[] = wards.map((w) => bed(w.type));
const ranked = (type: WardType, stepUp = false): RankedBed => ({
  bedId: `${type}-1`,
  score: 1,
  reasons: [],
  reason: '',
  stepUp,
});
const req = (over: Partial<AdmissionRequestInput> = {}): AdmissionRequestInput => ({
  age: 40,
  gender: 'Male',
  roomClass: 'general',
  needs: [],
  department: 'General Medicine',
  expectedStayDays: 2,
  notes: '',
  ...over,
});

describe('agent policy', () => {
  test('splitExtraNeeds sends oxygen and fall risk to auto and the ward-changing needs to confirm', () => {
    const out = splitExtraNeeds(
      [
        { need: 'oxygen', evidence: 'on O2' },
        { need: 'highFallRisk', evidence: 'unsteady' },
        { need: 'isolation', evidence: 'TB' },
        { need: 'ventilator', evidence: 'vent' },
        { need: 'pregnant', evidence: 'pregnant' },
        { need: 'monitor', evidence: 'telemetry' },
        { need: 'oxygen', evidence: 'duplicate' },
      ],
      [],
      [],
    );
    assert.deepEqual(out.auto.map((n) => n.need), ['oxygen', 'highFallRisk']);
    assert.deepEqual(out.confirm.map((n) => n.need), ['isolation', 'ventilator', 'pregnant', 'monitor']);
  });

  test('splitExtraNeeds ignores needs already ticked or dismissed', () => {
    const out = splitExtraNeeds(
      [
        { need: 'isolation', evidence: 'TB' },
        { need: 'oxygen', evidence: 'on O2' },
        { need: 'monitor', evidence: 'telemetry' },
      ],
      ['isolation'],
      ['oxygen'],
    );
    assert.deepEqual(out.auto, []);
    assert.deepEqual(out.confirm.map((n) => n.need), ['monitor']);
  });

  test('autoClasses follows the ticked needs', () => {
    assert.deepEqual(autoClasses(req({ needs: ['isolation'] })), ['isolation']);
    assert.deepEqual(autoClasses(req({ needs: ['ventilator'] })), ['icu']);
    assert.deepEqual(autoClasses(req({ needs: ['monitor'], roomClass: 'icu' })), ['icu']);
    assert.deepEqual(autoClasses(req({ needs: ['monitor'], roomClass: 'hdu' })), ['hdu']);
    assert.deepEqual(autoClasses(req({ needs: ['monitor'] })), ['hdu', 'icu']);
    assert.deepEqual(autoClasses(req({ age: 8 })), ['paediatric']);
    assert.deepEqual(autoClasses(req({ age: 8, roomClass: 'icu' })), ['icu']);
    assert.deepEqual(autoClasses(req({ needs: ['pregnant'] })), ['maternity']);
    assert.deepEqual(autoClasses(req({ needs: ['pregnant'], roomClass: 'icu' })), ['icu']);
    assert.deepEqual(autoClasses(req({ roomClass: 'twin' })), ['twin']);
  });

  test('autoAssignable never returns a step-up or a nearest-class bed', () => {
    const out = autoAssignable(req(), [ranked('twin'), ranked('hdu', true)], wards, beds);
    assert.deepEqual(out, []);
  });

  test('autoAssignable puts HDU before ICU for monitor on a general request', () => {
    const out = autoAssignable(
      req({ needs: ['monitor'] }),
      [ranked('icu', true), ranked('hdu', true), ranked('general')],
      wards,
      beds,
    );
    assert.deepEqual(out, []);
    const mixed = autoAssignable(
      req({ needs: ['monitor'] }),
      [ranked('icu'), ranked('hdu')],
      wards,
      beds,
    );
    assert.deepEqual(mixed.map((r) => r.bedId), ['hdu-1', 'icu-1']);
  });

  test('nearestOptionText names the twin room and the price difference', () => {
    assert.equal(
      nearestOptionText(req(), [ranked('twin')], wards, beds),
      'No General ward beds free. Twin room available, ₹700 more a day',
    );
    assert.equal(nearestOptionText(req(), [ranked('general')], wards, beds), null);
  });

  test('nearestOptionText says less or same price when not dearer', () => {
    assert.equal(
      nearestOptionText(req({ roomClass: 'twin' }), [ranked('general')], wards, beds),
      'No Twin room beds free. General ward available, ₹700 less a day',
    );
    const same = [...wards.filter((w) => w.type !== 'twin'), ward('twin', 800)];
    assert.equal(
      nearestOptionText(req(), [ranked('twin')], same, beds),
      'No General ward beds free. Twin room available, same price',
    );
  });

  test('isStepDown is true for ICU or HDU to a ward and false otherwise', () => {
    assert.equal(isStepDown('icu', 'general'), true);
    assert.equal(isStepDown('hdu', 'twin'), true);
    assert.equal(isStepDown('icu', 'hdu'), false);
    assert.equal(isStepDown('hdu', 'icu'), false);
    assert.equal(isStepDown('general', 'twin'), false);
  });
});
