import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../../test/test-db';

const DOCTOR = { id: 'u-doc', name: 'Dr. Shajin' };
const T0 = new Date(2026, 8, 26, 10, 0, 0, 0);
const duplicate = (e: any) => e?.code === 11000;
const invalid = (e: any) => e?.name === 'ValidationError';

describe('discharge records', () => {
  const m = models();

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
  });

  const order = (plan: Types.ObjectId, state: string, extra: Record<string, unknown> = {}) =>
    m.DischargeOrder.create({
      plan,
      admission: new Types.ObjectId(),
      patient: new Types.ObjectId(),
      kind: 'home',
      state,
      plannedLeaveAt: T0,
      windowAt: T0,
      diagnosis: 'Acute appendicitis, operated',
      orderedBy: DOCTOR,
      orderedAt: T0,
      ...extra,
    });

  const plan = (admission: Types.ObjectId, extra: Record<string, unknown> = {}) =>
    m.DischargePlan.create({
      admission,
      patient: new Types.ObjectId(),
      patientUhid: 'MHK202600001',
      patientName: 'David Raj',
      bedLabel: 'GWA-12',
      wardName: 'General Ward A',
      targetDay: '2026-09-27',
      targetAt: T0,
      ...extra,
    });

  test('a second active order for one plan is refused by the index, a cancelled one is not', async () => {
    const planId = new Types.ObjectId();
    const first = await order(planId, 'ordered');
    await assert.rejects(order(planId, 'ordered'), duplicate, 'two ordered');
    await assert.rejects(order(planId, 'ready'), duplicate, 'ordered and ready');
    await order(planId, 'cancelled'); // a cancelled order sits beside the active one
    await m.DischargeOrder.updateOne({ _id: first._id }, { $set: { state: 'cancelled' } });
    const second = await order(planId, 'ordered'); // after a cancel the plan can be ordered again
    await m.DischargeOrder.updateOne({ _id: second._id }, { $set: { state: 'left' } });
    await assert.rejects(order(planId, 'ordered'), duplicate, 'a plan whose patient left cannot be ordered again');
    await order(new Types.ObjectId(), 'ordered'); // another plan is free
    assert.equal(await m.DischargeOrder.countDocuments({ plan: planId }), 3);
  });

  test('an order starts empty, and its kind is never left-without-discharge; a plan can complete as one', async () => {
    const o = await order(new Types.ObjectId(), 'ordered');
    assert.deepEqual(
      { note: o.note, noTakeHome: o.noTakeHome, noFollowUp: o.noFollowUp, followUpLater: [...o.followUpLater], lines: [...o.lines], announced: [...o.announced] },
      { note: '', noTakeHome: false, noFollowUp: false, followUpLater: [], lines: [], announced: [] },
    );
    await assert.rejects(order(new Types.ObjectId(), 'ordered', { kind: 'left-without-discharge' }), invalid);
    await assert.rejects(order(new Types.ObjectId(), 'ordered', { lines: [{ key: 'wristband', state: 'done' }] }), invalid, 'an unknown line');
    await assert.rejects(order(new Types.ObjectId(), 'ordered', { lines: [{ key: 'bill', state: 'paid' }] }), invalid, 'an unknown line state');

    const p = await plan(new Types.ObjectId());
    assert.equal(p.state, 'planned');
    assert.deepEqual([...p.targetLog], []);
    p.set({ state: 'completed', completedAt: T0, completedKind: 'left-without-discharge' });
    await p.save();
    await assert.rejects(plan(new Types.ObjectId(), { state: 'cancelled' }), invalid, 'a plan has no cancelled state');
  });

  test('one plan per admission, one summary per order and one snapshot per moment', async () => {
    const admission = new Types.ObjectId();
    await plan(admission);
    await assert.rejects(plan(admission), duplicate, 'a second plan for the admission');

    const orderId = new Types.ObjectId();
    const summary = { order: orderId, kind: 'home', course: { text: 'Recovered well.', source: 'ai-sample' } };
    const s = await m.DischargeSummary.create(summary);
    assert.deepEqual({ sections: s.sections, versions: [...s.versions] }, { sections: {}, versions: [] });
    await assert.rejects(m.DischargeSummary.create(summary), duplicate, 'a second summary for the order');
    await assert.rejects(m.DischargeSummary.create({ ...summary, order: new Types.ObjectId(), course: { text: 'x', source: 'unknown' } }), invalid, 'an unknown course source');

    const counts = { dueToday: 3, noOrder: 1, clearing: 1, ready: 1, leftToday: 2, avgMinutes: 95 };
    await m.DischargeSnapshot.create({ at: T0, counts });
    await assert.rejects(m.DischargeSnapshot.create({ at: T0, counts }), duplicate, 'a second snapshot at the same moment');
    const empty = await m.DischargeSnapshot.create({ at: new Date(T0.getTime() + 3_600_000) });
    assert.equal(empty.counts.leftToday, 0);
    assert.equal(empty.counts.avgMinutes, null, 'nobody left yet');
  });
});
