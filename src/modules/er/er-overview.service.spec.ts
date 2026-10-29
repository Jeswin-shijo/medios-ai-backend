import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { Actor } from '../beds/actor';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { ErOverviewService } from './er-overview.service';
import { ErTargetsService } from './er-targets.service';

const ADMIN: Actor = { id: 'u-admin', name: 'Admin', role: UserRole.ADMIN };
const DOCTOR: Actor = { id: 'u-doc', name: 'Dr Shajin', role: UserRole.DOCTOR };
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('ErOverviewService and ErTargetsService', () => {
  const m = models();
  let overview: ErOverviewService;
  let targets: ErTargetsService;
  let n: number;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    n = 0;
    overview = new ErOverviewService(m.ErSnapshot, m.ErVisit, m.Clock);
    targets = new ErTargetsService(new SettingsService(m.HospitalSettings));
  });

  const midnight = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  };

  /** One visit. Times are minutes after `arrived` (a clinic-clock Date). */
  const visit = async (o: {
    colour?: string;
    status?: string;
    arrived?: Date;
    triageAfter?: number;
    doctorAfter?: number;
    leftAfter?: number;
    createdAt?: Date;
    retriage?: string;
  } = {}) => {
    n++;
    const arrived = o.arrived ?? new Date(Date.now() - 2 * HOUR);
    const at = (min: number) => new Date(arrived.getTime() + min * MIN);
    const colour = o.colour;
    const doc = await m.ErVisit.create({
      number: `ER-${String(n).padStart(4, '0')}`,
      patient: new Types.ObjectId(),
      patientUhid: `MHK20260${n}`,
      patientName: 'Ravi Kumar',
      mode: 'walk-in',
      complaint: 'other',
      arrivedAt: arrived,
      status: o.status ?? (colour ? 'waiting-doctor' : 'waiting-triage'),
      case: new Types.ObjectId(),
      ...(colour
        ? {
            triage: {
              suggested: colour,
              colour: o.retriage ?? colour,
              byName: 'Nurse',
              at: at(o.triageAfter ?? 5),
              history: [{ colour, byName: 'Nurse', at: at(o.triageAfter ?? 5), kind: 'triage' }],
            },
          }
        : {}),
      ...(o.doctorAfter !== undefined ? { doctorSeenAt: at(o.doctorAfter) } : {}),
      ...(o.leftAfter !== undefined ? { leftAt: at(o.leftAfter) } : {}),
    });
    if (o.createdAt) await m.ErVisit.collection.updateOne({ _id: doc._id }, { $set: { createdAt: o.createdAt } });
    return doc;
  };

  test('cards count patients in the ER and red patients', async () => {
    await visit({ colour: 'red' });
    await visit({ colour: 'red', retriage: 'orange' }); // now orange
    await visit({ colour: 'yellow' });
    await visit(); // waiting for triage is still in the ER
    await visit({ colour: 'red', status: 'left', leftAfter: 60 });
    const o = await overview.overview();
    assert.equal(o.cards.patientsInEr.value, 4);
    assert.equal(o.cards.critical.value, 1);
    assert.equal(o.cards.avgTriageMin.note.length > 0, true);
  });

  test('average triage time is arrival to confirmed triage', async () => {
    await visit({ colour: 'yellow', triageAfter: 4 });
    await visit({ colour: 'green', triageAfter: 9 });
    await visit(); // not triaged: left out
    // yesterday's visit is not counted
    await visit({ colour: 'red', triageAfter: 60, createdAt: new Date(midnight().getTime() - HOUR) });
    const o = await overview.overview();
    assert.equal(o.cards.avgTriageMin.value, 7); // (4 + 9) / 2 = 6.5, rounded
    assert.equal(o.performance.avgTriageMin, 7);
  });

  test('a re-triage does not change the average triage time', async () => {
    const v = await visit({ colour: 'yellow', triageAfter: 4 });
    const before = (await overview.overview()).performance.avgTriageMin;
    await m.ErVisit.updateOne(
      { _id: v._id },
      {
        $set: { 'triage.colour': 'red' },
        $push: { 'triage.history': { colour: 'red', byName: 'Dr', at: new Date(Date.now() + 30 * MIN), kind: 'retriage', reason: 'worse' } },
      },
    );
    const after = await overview.overview();
    assert.equal(before, 4);
    assert.equal(after.performance.avgTriageMin, 4);
    assert.equal(after.colours[0].count, 1);
  });

  test('colour rows give counts, targets and average waits', async () => {
    await visit({ colour: 'red', doctorAfter: 4, status: 'in-treatment' });
    await visit({ colour: 'red', doctorAfter: 9, status: 'in-treatment' });
    await visit({ colour: 'red' });
    await visit({ colour: 'orange', doctorAfter: 20, status: 'left', leftAfter: 90 });
    await visit({ colour: 'green' });
    const o = await overview.overview();
    assert.deepEqual(o.colours.map((c) => c.colour), ['red', 'orange', 'yellow', 'green']);
    assert.deepEqual(o.colours.map((c) => c.targetMin), [10, 30, 120, 240]);
    assert.deepEqual(o.colours.map((c) => c.count), [3, 0, 0, 1]);
    // A left visit has no count but its wait still shows.
    assert.deepEqual(o.colours.map((c) => c.avgWaitMin), [7, 20, null, null]);
    assert.equal(o.performance.avgStayMin, 90);
    assert.equal(o.performance.arrivalsByHour.length, 24);
    assert.equal(o.performance.arrivalsByHour.reduce((a, b) => a + b, 0), 5);
  });

  test('the on-time card reads the doctor reviews finished today, not reviews closed by the patient leaving', async () => {
    const seen = await visit({ colour: 'orange', doctorAfter: 10 });
    const gone = await visit({ colour: 'orange', status: 'left', leftAfter: 20 });
    const now = new Date();
    const clock = (v: any, dueMin: number) => ({ def: 'er-doctor', case: v.case, state: 'met', startedAt: now, dueAt: new Date(now.getTime() + dueMin * MIN), stoppedAt: now });
    await m.Clock.collection.insertMany([clock(seen, 1), clock(seen, -1), clock(gone, -1)] as any[]);
    const o = await overview.overview();
    assert.equal(o.cards.onTimePct.value, 50);
    assert.equal(o.performance.onTimePct, 50);
  });

  test('snapshot upserts one record per real hour', async () => {
    await visit({ colour: 'red' });
    await overview.snapshot();
    await visit({ colour: 'yellow' });
    await overview.snapshot();
    const rows: any[] = await m.ErSnapshot.find().lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].patientsInEr, 2);
    assert.equal(rows[0].critical, 1);
    assert.equal(rows[0].avgTriageMin, 5);

    const { points } = await overview.series('24h');
    assert.equal(points.length, 24);
    assert.equal(points[23].patientsInEr, 2);
    assert.equal(points[0].patientsInEr, null);
    assert.equal((await overview.series('7d')).points.length, 168);
    const o = await overview.overview();
    assert.equal(o.cards.patientsInEr.spark.length, 24);
    assert.equal(o.cards.patientsInEr.spark[23], 2);
  });

  test('only an admin changes pathway targets', async () => {
    assert.equal((await targets.getTargets())['stroke.doctor'], 10);
    await assert.rejects(targets.saveTargets(DOCTOR, { 'stroke.doctor': 5 }), (e: any) => e.status === 403);
    const saved = await targets.saveTargets(ADMIN, { 'stroke.doctor': 5 });
    assert.equal(saved['stroke.doctor'], 5);
    assert.equal(saved['chest-pain.ecg'], 10);
    // A second save merges over the first.
    const again = await targets.saveTargets(ADMIN, { 'chest-pain.ecg': 8 });
    assert.equal(again['stroke.doctor'], 5);
    assert.equal(again['chest-pain.ecg'], 8);
    // The settings route refuses a non-admin's er patch too.
    const settings = new SettingsService(m.HospitalSettings);
    await assert.rejects(settings.updateSettings({ er: { targets: { 'stroke.doctor': 99 } } } as any, { role: 'doctor' }), (e: any) => e.status === 403);
    await settings.updateSettings({ er: { targets: { 'stroke.doctor': 5, 'chest-pain.ecg': 8 } } } as any, { role: 'doctor' });
  });

  test('saveTargets rejects an unknown key and values outside 1 to 240', async () => {
    await assert.rejects(targets.saveTargets(ADMIN, { 'stroke.ecg': 5 }), (e: any) => e.status === 400 && e.message.includes('stroke.ecg'));
    for (const bad of [0, 241, 1.5, '10']) {
      await assert.rejects(targets.saveTargets(ADMIN, { 'stroke.doctor': bad }), (e: any) => e.status === 400 && e.message.includes('stroke.doctor'));
    }
    assert.equal((await targets.getTargets())['stroke.doctor'], 10);
  });
});
