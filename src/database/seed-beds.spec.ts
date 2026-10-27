import * as assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { isoDate } from '../common/utils/clinic-time';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../test/test-db';
import { seedBeds } from './seed-beds';

describe('seedBeds', () => {
  const { Bed, Admission, Patient } = models();

  before(async () => {
    await connectTestDb();
    await resetTestDb();
    // The two demo patients who occupy a bed by name.
    await Patient.create([
      { uhid: 'MHK202500325', name: 'David Raj', age: 45, gender: 'Male', phone: '9000000325' },
      { uhid: 'MHK202500327', name: 'James Wilson', age: 62, gender: 'Male', phone: '9000000327' },
    ]);
  });

  after(async () => {
    await closeTestDb();
  });

  test('bed and admission times fall on the demo clinic day, not the real date', async (t) => {
    t.mock.method(console, 'log', () => undefined);
    await seedBeds('2026-09-26');

    const beds = await Bed.find().lean().exec();
    assert.equal(beds.length, 138);
    assert.ok(beds.every((b) => isoDate(b.stateSince) === '2026-09-26'));

    const admissions = await Admission.find().lean().exec();
    const named = admissions.filter((a) => !a.sample);
    assert.equal(named.length, 2);
    // Admitted two days before the demo day.
    assert.ok(named.every((a) => isoDate(a.admittedAt) === '2026-09-24'));
    // Sample inpatients: one per sample bed, never admitted after the demo day.
    const sample = admissions.filter((a) => a.sample);
    assert.equal(sample.length, beds.filter((b) => b.sample).length);
    assert.ok(sample.every((a) => isoDate(a.admittedAt) <= '2026-09-26'));
    assert.equal(beds.filter((b) => b.state === 'occupied' && !b.admission).length, 0);
  });
});
