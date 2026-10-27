import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { PatientsService } from '../patients/patients.service';
import { BedAlerts } from './bed-alerts';
import { BedEvents } from './bed-events';
import { BedOverviewService } from './bed-overview.service';
import { BedRequestsService } from './bed-requests.service';
import { BedsService } from './beds.service';
import { UserRole } from '../users/schemas/user.schema';

const HOUR = 3_600_000;
const NURSE = { id: 'u1', name: 'Nurse', role: UserRole.NURSE };

describe('BedOverviewService', () => {
  const { Ward, Bed, Admission, Patient, BedRequest, BedSnapshot, TaskAlertItem } = models();
  let service: BedOverviewService;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    const icu = await Ward.create({ code: 'ICU', name: 'ICU', shortName: 'ICU', floor: 0, type: 'icu', gender: 'any', ratePerDay: 7500, nearDepartments: [], sortOrder: 0 });
    const gen = await Ward.create({ code: 'GA', name: 'General A', shortName: 'GA', floor: 1, type: 'general', gender: 'any', ratePerDay: 1500, nearDepartments: [], sortOrder: 1 });
    const bed = (ward: any, number: number, state: string, label: string) =>
      Bed.create({ ward: ward._id, label, number, features: [], state, stateSince: new Date() });
    const icu1 = await bed(icu, 1, 'occupied', 'ICU • Bed 1');
    await bed(icu, 2, 'free', 'ICU • Bed 2');
    await bed(gen, 1, 'occupied', 'GA • Bed 1');
    await bed(gen, 2, 'cleaning', 'GA • Bed 2');
    await bed(gen, 3, 'blocked', 'GA • Bed 3');
    await bed(gen, 4, 'free', 'GA • Bed 4');
    const admission = await Admission.create({
      patient: icu1._id, patientUhid: 'U1', patientName: 'Asha', bed: icu1._id, roomClass: 'icu', department: 'Cardiology',
      expectedStayDays: 1, admittedAt: new Date(Date.now() - 20 * HOUR), admittedBy: 'x', sample: true,
    });
    await Bed.updateOne({ _id: icu1._id }, { admission: admission._id });

    const events = new BedEvents();
    const patients = new PatientsService(Patient);
    const beds = new BedsService(Ward, Bed, Admission, patients, events);
    const requests = new BedRequestsService(BedRequest, patients, beds, new BedAlerts(TaskAlertItem), events);
    service = new BedOverviewService(BedSnapshot, Admission, beds, requests);
  });

  test('snapshot upserts one record per real hour', async () => {
    await service.snapshot();
    await service.snapshot();
    const all = await BedSnapshot.find().lean();
    assert.equal(all.length, 1);
    assert.equal(all[0].hour.getTime() % HOUR, 0);
    assert.equal(all[0].hour.getTime(), Math.floor(Date.now() / HOUR) * HOUR);
    assert.deepEqual(all[0].totals, { total: 6, occupied: 2, free: 2, cleaning: 1, blocked: 1, held: 0 });
    assert.deepEqual(all[0].byType.icu, { total: 2, occupied: 1, free: 1, cleaning: 0, blocked: 0 });
    assert.deepEqual(all[0].byType.general, { total: 4, occupied: 1, free: 1, cleaning: 1, blocked: 1 });
    assert.deepEqual(all[0].expected, { discharges: 1, admissions: 1 });
  });

  test('overview cards match the board totals', async () => {
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    const old = { total: 6, occupied: 1, free: 3, cleaning: 1, blocked: 1, held: 0 };
    await BedSnapshot.create({ hour: new Date(hour - 24 * HOUR), at: new Date(hour - 24 * HOUR), totals: old, byType: {}, expected: { discharges: 2, admissions: 1 } });
    await BedSnapshot.create({ hour: new Date(hour - 23 * HOUR), at: new Date(hour - 23 * HOUR), totals: { ...old, occupied: 3 }, byType: {} });
    const o = await service.overview(NURSE);
    assert.deepEqual(o.totals, { total: 6, occupied: 2, free: 2, cleaning: 1, held: 0, blocked: 1, percentFull: 33 });
    assert.equal(o.cards.total.value, 6);
    assert.equal(o.cards.occupied.value, 2);
    assert.equal(o.cards.occupied.total, 6);
    assert.equal(o.cards.occupied.note, '33% occupancy');
    assert.equal(o.cards.occupied.trendPct, 100);
    assert.equal(o.cards.available.value, 2);
    assert.equal(o.cards.available.note, 'Ready for allocation');
    assert.equal(o.cards.available.trendPct, -33);
    assert.equal(o.cards.cleaning.value, 1);
    assert.equal(o.cards.cleaning.note, '17% of beds');
    assert.equal(o.cards.blocked.value, 1);
    assert.equal(o.cards.cleaningBlocked.value, 2);
    assert.equal(o.cards.cleaningBlocked.note, 'Under cleaning or maintenance');
    assert.equal(o.cards.cleaningBlocked.trendPct, 0);
    assert.equal(o.cards.expectedDischarges.value, 1);
    assert.equal(o.cards.expectedDischarges.note, 'Next 24 hours');
    assert.equal(o.cards.expectedDischarges.trendPct, -50);
    assert.equal(o.cards.expectedAdmissions.value, 1);
    assert.equal(o.cards.expectedAdmissions.note, '0 open + 1/day average');
    assert.equal(o.cards.expectedAdmissions.trendPct, 0);
    assert.equal(o.openRequests, 0);
    assert.equal(o.avgAdmissionsPerDay, 1);
    for (const card of Object.values(o.cards)) assert.equal(card.spark.length, 24);
    assert.equal(o.cards.occupied.spark[0], 3);
    assert.equal(o.cards.occupied.spark[23], null);
    assert.deepEqual(o.byType.map((r) => [r.type, r.label, r.total, r.percentFull]), [['icu', 'ICU', 2, 50], ['general', 'General ward', 4, 25]]);
    assert.equal(o.dischargePlan.length, 1);
    assert.equal(o.dischargePlan[0].patientName, 'Asha');
    assert.equal(o.dischargePlan[0].bedLabel, 'ICU • Bed 1');
    assert.equal(o.dischargePlan[0].wardName, 'ICU');
    assert.equal(o.movements[0].kind, 'admission');
    assert.equal(o.movements[0].to, 'ICU • Bed 1');
    assert.ok(o.suggestions.length > 0);
  });

  test('series fills missing hours with null', async () => {
    await service.snapshot();
    const day = await service.series('24h');
    assert.equal(day.range, '24h');
    assert.equal(day.points.length, 24);
    assert.deepEqual(day.points[23], { hour: new Date(Math.floor(Date.now() / HOUR) * HOUR).toISOString(), occupied: 2, free: 2, cleaning: 1, blocked: 1 });
    assert.equal(day.points[0].occupied, null);
    assert.equal((await service.series('7d')).points.length, 168);
  });
});
