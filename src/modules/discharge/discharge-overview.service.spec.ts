import * as assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { hourOf } from '../../common/utils/series';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AiProvider } from '../ai/ai-provider';
import { AiProviderName } from '../ai/ai-types';
import { AiService } from '../ai/ai.service';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { MessagesService } from '../coordinator/messages.service';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { DischargeAiService } from './discharge-ai';
import { DischargeKind, LINE_KEYS, LINE_RULE, LineKey } from './discharge-catalogue';
import { DischargeOverviewService } from './discharge-overview.service';
import { DischargeSettingsService } from './discharge-settings.service';

const DOCTOR = { id: 'u-doc', name: 'Dr. Shajin' };
const NURSE = { id: 'n1', name: 'Nurse Anjali Thomas' };
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A clinic-clock (local) moment in September 2026. */
const at = (day: number, h: number, min = 0) => new Date(2026, 8, day, h, min, 0, 0);
/** Not on any hour or half hour, so the snapshot hour is the same in every time zone's reading of it. */
const NOW = at(26, 11, 17);
const YESTERDAY = '2026-09-25';
const TODAY = '2026-09-26';
const TOMORROW = '2026-09-27';
const LATER = '2026-09-29';
const WARD_A = 'General ward A (men)';
const WARD_B = 'Private ward';
const DIAGNOSIS = 'Community-acquired pneumonia, treated';
const NAMES = ['David Raj', 'Priya Thomas', 'Ravi Kumar', 'Anitha Selvam', 'Arjun Prakash', 'Joseph Mathew', 'Meena George', 'Kavitha Raman', 'Suresh Babu', 'Lakshmi Devi'];
const HOME_REQUIRED: LineKey[] = ['order', 'summary', 'lab', 'take-home', 'follow-up', 'teaching', 'bill'];
const iso = (d: Date) => d.toISOString();
/** A real-time value from `toRealTime`: the clinic moment shifted by the clocks' gap, which can be a millisecond off. */
const near = (value: string | undefined, want: Date) => {
  assert.ok(value && Math.abs(new Date(value).getTime() - want.getTime()) < 1000, `${value} is not ${iso(want)}`);
};

/** The day at 11:00, as a target time. */
const dayAt = (day: string) => {
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(y, mo - 1, d, 11, 0, 0, 0);
};

/** The required lines of a kind, each done if listed, else waiting. */
const linesOf = (kind: DischargeKind, done: LineKey[]) =>
  LINE_KEYS.filter((k) => LINE_RULE[kind][k] === 'R').map((key) => ({ key, state: done.includes(key) ? 'done' : 'waiting' }));

function stubProvider(name: AiProviderName, answer: unknown = { text: 'A calm day on the wards.' }) {
  const calls: { instructions: string; input: Record<string, unknown> }[] = [];
  const p: AiProvider = {
    name,
    model: 'm',
    complete: async (req) => {
      calls.push({ instructions: req.instructions, input: req.input });
      return answer;
    },
    check: async () => ({ ok: true, detail: 'fine' }),
  };
  return { p, calls };
}
const aiOf = (p: AiProvider) => new DischargeAiService(new AiService(p, { getSettings: async () => ({ ai: {} }) } as any, { get: () => 50 } as any));

describe('DischargeOverviewService', () => {
  const m = models();
  let overview: DischargeOverviewService;
  let cases: CasesService;
  let settings: DischargeSettingsService;
  let seq: number;
  let savedClinic: string | undefined;

  /** A plan for a new stay, its own patient, admission and bed. */
  const plan = async (targetDay: string, extra: Record<string, unknown> = {}) => {
    const n = seq++;
    return m.DischargePlan.create({
      admission: new Types.ObjectId(),
      patient: new Types.ObjectId(),
      patientUhid: `MHK2026${String(n + 1).padStart(5, '0')}`,
      patientName: NAMES[n % NAMES.length],
      bedLabel: `GWA-${String(n + 1).padStart(2, '0')}`,
      wardName: WARD_A,
      doctor: 'Dr. Shajin',
      targetDay,
      targetAt: dayAt(targetDay),
      ...extra,
    });
  };

  /** The plan's order: Home, window open at 11:00, leaving at 13:00, only the order line done, unless `extra` says otherwise. */
  const order = (p: any, extra: Record<string, unknown> = {}) =>
    m.DischargeOrder.create({
      plan: p._id,
      admission: p.admission,
      patient: p.patient,
      kind: 'home',
      state: 'ordered',
      plannedLeaveAt: at(26, 13),
      windowAt: at(26, 11),
      diagnosis: DIAGNOSIS,
      condition: 'improved',
      orderedBy: DOCTOR,
      orderedAt: at(26, 9),
      lines: linesOf('home', ['order']),
      ...extra,
    });

  /** A stay with an open order (state as the order's), or with none when `orderExtra` is null. */
  const stay = async (targetDay: string, orderExtra: Record<string, unknown> | null = null, planExtra: Record<string, unknown> = {}) => {
    const p = await plan(targetDay, planExtra);
    if (!orderExtra) return { plan: p, order: null as any };
    const o = await order(p, orderExtra);
    await m.DischargePlan.updateOne({ _id: p._id }, { $set: { state: o.state, order: o._id } });
    return { plan: p, order: o };
  };

  /** A stay that ended: the order left as its own kind (unless `endedAs` says otherwise), the plan completed then. */
  const gone = async (
    o: { kind?: DischargeKind; windowAt: Date; leftAt: Date; endedAs?: string; gatePass?: unknown },
    planExtra: Record<string, unknown> = {},
  ) => {
    const kind = o.kind ?? 'home';
    const endedAs = o.endedAs ?? kind;
    const p = await plan(TODAY, { state: 'completed', completedAt: o.leftAt, completedKind: endedAs, ...planExtra });
    const done = await order(p, {
      kind,
      state: 'left',
      windowAt: o.windowAt,
      plannedLeaveAt: o.windowAt,
      orderedAt: o.windowAt,
      leftAt: o.leftAt,
      leftBy: NURSE,
      endedAs,
      lines: linesOf(kind, LINE_KEYS.filter((k) => LINE_RULE[kind][k] === 'R')),
      ...(kind === 'died' ? { condition: undefined, timeOfDeath: at(26, 8), causeOfDeath: 'Cardiogenic shock' } : {}),
      ...(o.gatePass ? { gatePass: o.gatePass } : {}),
    });
    await m.DischargePlan.updateOne({ _id: p._id }, { $set: { order: done._id } });
    return { plan: p, order: done };
  };

  const cardValues = (cards: Record<string, { value: number | null }>) => Object.fromEntries(Object.entries(cards).map(([k, c]) => [k, c.value]));
  const ids = (rows: { planId: string }[]) => rows.map((r) => r.planId);

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    savedClinic = process.env.CLINIC_DATE;
    delete process.env.CLINIC_DATE;
    seq = 0;
    await resetTestDb();
    await m.HospitalSettings.create({ queue: { counters: ['Room 101'] } });
    const registry = new AgentRegistry();
    const messages = new MessagesService(m.AgentMessage, registry, new CoordinatorEvents());
    cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    settings = new DischargeSettingsService(new SettingsService(m.HospitalSettings));
    overview = new DischargeOverviewService(
      settings, cases, aiOf(stubProvider('none').p), m.DischargePlan, m.DischargeOrder, m.DischargeSummary, m.DischargeSnapshot, m.LabRequest, m.LabLine,
    );
    overview.clock = () => NOW;
  });
  afterEach(() => {
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
  });

  // ---------- the cards ----------

  test('cards count due today, no order, clearing, ready and beds freeing', async () => {
    await stay(TODAY); // due today, no order
    await stay(YESTERDAY); // overdue, no order: still due
    await stay(TOMORROW); // due tomorrow
    await stay(LATER); // planned
    await stay(TOMORROW, { plannedLeaveAt: at(26, 13) }); // ordered for today, though the target was tomorrow
    await stay(TODAY, { state: 'ready', plannedLeaveAt: at(26, 12), lines: linesOf('home', HOME_REQUIRED) });
    await stay(TODAY, { plannedLeaveAt: at(27, 10), windowAt: at(27, 8) }); // ordered for tomorrow: clearing, not due today
    await gone({ windowAt: at(26, 8), leftAt: at(26, 9, 30) }); // left today
    await gone({ windowAt: at(25, 8), leftAt: at(25, 10) }); // left yesterday

    const o = await overview.overview();
    assert.deepEqual(cardValues(o.cards), { dueToday: 4, clearing: 2, ready: 1, orderToLeaving: 90, bedsFreeingToday: 3 });
    assert.equal(o.cards.dueToday.note, '2 with no order yet');
    assert.equal(o.cards.clearing.note, 'order given, lines open');
    assert.equal(o.cards.ready.note, 'gate pass can print');
    // B2-M4: in minutes, as the card's value is.
    assert.equal(o.cards.orderToLeaving.note, 'target 120 min');
    assert.equal(o.cards.bedsFreeingToday.note, 'leaving or left today');
    for (const c of Object.values(o.cards)) {
      assert.equal(c.total, null);
      assert.equal(c.trendPct, null, 'no snapshot from yesterday');
      assert.equal(c.spark.length, 24);
      assert.ok(c.spark.every((x) => x === null), 'no snapshots yet');
    }
    assert.equal(o.generatedAt, iso(NOW));
    assert.equal(o.targetMinutes, 120);

    await settings.save({ id: 'a1', name: 'Admin', role: UserRole.ADMIN }, { leaveMinutes: 90 });
    assert.equal((await overview.overview()).cards.orderToLeaving.note, 'target 90 min');
  });

  test('the average uses windowAt to leftAt, and is null with nobody left', async () => {
    await stay(TODAY, {}); // an open order is not timed
    let o = await overview.overview();
    assert.equal(o.cards.orderToLeaving.value, null);
    assert.equal(o.cards.orderToLeaving.trendPct, null);

    // Ordered at 06:00, window at 08:00, left 09:40: 100 minutes from the window, not 220 from the order.
    const first = await gone({ windowAt: at(26, 8), leftAt: at(26, 9, 40) });
    await m.DischargeOrder.updateOne({ _id: first.order._id }, { $set: { orderedAt: at(26, 6) } });
    await gone({ windowAt: at(26, 9), leftAt: at(26, 10, 20) }); // 80 minutes
    o = await overview.overview();
    assert.equal(o.cards.orderToLeaving.value, 90);
  });

  // ---------- the queue ----------

  test('queue order: open windows first, then no-order overdue, then due today, then tomorrow (R46)', async () => {
    const tomorrow = await stay(TOMORROW);
    const overdue = await stay(YESTERDAY);
    const later = await stay(LATER);
    const dueToday = await stay(TODAY);
    const notOpen = await stay(TODAY, { windowAt: at(26, 14), plannedLeaveAt: at(26, 16) });
    const openLate = await stay(TODAY, { windowAt: at(26, 10), plannedLeaveAt: at(26, 12), lines: linesOf('home', ['order', 'lab', 'take-home']) });
    const openEarly = await stay(TOMORROW, { state: 'ready', windowAt: at(26, 9), plannedLeaveAt: at(26, 11), lines: linesOf('home', HOME_REQUIRED) });
    await gone({ windowAt: at(26, 7), leftAt: at(26, 8) }); // left: never in the queue

    const o = await overview.overview();
    const want = [openEarly, openLate, notOpen, overdue, dueToday, tomorrow].map((s) => String(s.plan._id));
    assert.deepEqual(ids(o.queue), want);
    assert.deepEqual(
      o.queue.map((r) => r.status),
      ['ready', 'ordered', 'ordered', 'overdue', 'due-today', 'due-tomorrow'],
    );

    const [ready, late, waiting, noOrder] = o.queue;
    assert.deepEqual(
      { done: ready.done, required: ready.required, waitingOn: ready.waitingOn, waitingKey: ready.waitingKey },
      { done: 7, required: 7, waitingOn: null, waitingKey: null },
    );
    assert.deepEqual(
      { done: late.done, required: late.required, waitingOn: late.waitingOn, waitingKey: late.waitingKey, kind: late.kind, windowOpen: late.windowOpen },
      { done: 3, required: 7, waitingOn: 'Summary signed', waitingKey: 'summary', kind: 'home', windowOpen: true },
    );
    assert.equal(late.orderId, String(openLate.order._id));
    assert.equal(late.windowAt, iso(at(26, 10)));
    assert.equal(late.plannedLeaveAt, iso(at(26, 12)));
    near(late.leaveDueAt, at(26, 12)); // the window plus the 2 h target, as real time
    assert.deepEqual(late.patient, { id: String(openLate.plan.patient), name: openLate.plan.patientName, uhid: openLate.plan.patientUhid });
    assert.deepEqual([late.bedLabel, late.wardName, late.doctor, late.targetDay], [openLate.plan.bedLabel, WARD_A, 'Dr. Shajin', TODAY]);
    assert.equal(waiting.windowOpen, false);
    assert.deepEqual(
      { orderId: noOrder.orderId, kind: noOrder.kind, done: noOrder.done, required: noOrder.required, waitingOn: noOrder.waitingOn, windowAt: noOrder.windowAt },
      { orderId: undefined, kind: undefined, done: 0, required: 0, waitingOn: 'Discharge order', windowAt: undefined },
    );

    // The full queue: every active plan, later targets last.
    assert.deepEqual(ids(await overview.queue({})), [...want, String(later.plan._id)]);
  });

  test('the queue filters by ward, doctor, status and search', async () => {
    const a = await stay(TODAY, null, { wardName: WARD_B, doctor: 'Dr. Arun' });
    const b = await stay(TOMORROW);
    const c = await stay(TODAY, { state: 'ready', lines: linesOf('home', HOME_REQUIRED) }, { wardName: WARD_B });
    const d = await stay(LATER, null, { doctor: 'Dr. Arun' });
    const e = await stay(TODAY, {});

    const of = (s: { plan: any }) => String(s.plan._id);
    const sorted = (rows: { planId: string }[]) => ids(rows).sort();
    assert.deepEqual(sorted(await overview.queue({ ward: WARD_B })), [of(a), of(c)].sort());
    assert.deepEqual(sorted(await overview.queue({ doctor: 'Dr. Arun' })), [of(a), of(d)].sort());
    assert.deepEqual(sorted(await overview.queue({ status: 'due' })), [of(a), of(b)].sort());
    assert.deepEqual(ids(await overview.queue({ status: 'ready' })), [of(c)]);
    assert.deepEqual(ids(await overview.queue({ status: 'ordered' })), [of(e)]);
    assert.deepEqual(ids(await overview.queue({ status: 'planned' })), [of(d)]);
    assert.deepEqual(ids(await overview.queue({ q: b.plan.patientName.split(' ')[0].toLowerCase() })), [of(b)]);
    assert.deepEqual(ids(await overview.queue({ q: c.plan.patientUhid })), [of(c)]);
    assert.deepEqual(ids(await overview.queue({ q: e.plan.bedLabel.toLowerCase() })), [of(e)]);
    assert.deepEqual(ids(await overview.queue({ q: '.*' })), [], 'search text is literal');
    assert.deepEqual(ids(await overview.queue({ ward: WARD_B, status: 'due', q: '  ' })), [of(a)]);
    await assert.rejects(overview.queue({ status: 'lost' as any }), BadRequestException);
  });

  // ---------- the detail ----------

  test('detail by plan and by admission match', async () => {
    // A plan and order with no case of their own: the patient's open case is the stay's (R24).
    const p = await plan(TODAY, { state: 'ordered' });
    const otherPatient = new Types.ObjectId();
    const theCase = await m.Case.create({
      number: 'CASE-0001', patient: p.patient, patientUhid: p.patientUhid, patientName: p.patientName, kind: 'ipd', priority: 'medium', openedAt: at(24, 10), openedBy: 'bed',
    });
    const otherCase = await m.Case.create({
      number: 'CASE-0002', patient: otherPatient, patientUhid: 'MHK202699999', patientName: 'Someone Else', kind: 'ipd', priority: 'medium', openedAt: at(24, 10), openedBy: 'bed',
    });
    const request = (number: string, onCase: any) =>
      m.LabRequest.create({
        number, patient: onCase.patient, patientUhid: onCase.patientUhid, patientName: onCase.patientName, case: onCase._id, orderedBy: DOCTOR, priority: 'urgent',
        orderedAt: at(25, Number(number.slice(-1)) + 8), collectBy: at(25, 12),
      });
    const test = (r: any, name: string, status: string, critical?: Record<string, unknown>) =>
      m.LabLine.create({ request: r._id, test: name, status, tatDueAt: at(25, 18), ...(critical ? { critical } : {}) });
    const lr1 = await request('LR-0001', theCase);
    await test(lr1, 'cbc', 'released');
    await test(lr1, 'crp', 'received');
    const lr2 = await request('LR-0002', theCase);
    await test(lr2, 'trop-i', 'released', { active: true });
    const lr3 = await request('LR-0003', theCase);
    await test(lr3, 'urine', 'received');
    await test(lr3, 'culture', 'cancelled');
    const elsewhere = await request('LR-0004', otherCase);
    await test(elsewhere, 'cbc', 'received');

    const takeHome = new Types.ObjectId();
    const added = new Types.ObjectId();
    const o = await order(p, {
      lines: [
        { key: 'order', state: 'done', by: DOCTOR, at: at(26, 9) },
        { key: 'summary', state: 'waiting' },
        { key: 'lab', state: 'waiting', detail: '1 critical result to acknowledge · 1 result waiting' },
        { key: 'take-home', state: 'done', detail: '2 issued' },
        { key: 'follow-up', state: 'done', detail: 'Booked: 2026-10-03 at 10:00' },
        { key: 'teaching', state: 'done', by: NURSE, at: at(26, 10), note: 'Inhaler technique shown' },
        // no bill line stored yet: it shows as waiting
      ],
      takeHomeOrder: takeHome,
      addedTakeHomeOrders: [added],
      followUp: { followUpId: 'f-1', status: 'booked', appointmentId: 'ap-1', date: '2026-10-03', time: '10:00' },
      followUpLater: [String(lr3._id)],
    });
    await m.DischargePlan.updateOne({ _id: p._id }, { $set: { order: o._id } });
    const s = await m.DischargeSummary.create({
      order: o._id, kind: 'home', sections: { diagnosis: DIAGNOSIS, note: 'Walk daily.' }, course: { text: 'Admitted to the general ward for 2 days.', source: 'ai-sample' },
    });
    const stored = await m.DischargeSummary.findById(s._id).lean<any>();

    const d = await overview.detail(String(p._id));
    assert.deepEqual(await overview.byAdmission(String(p.admission)), d);

    assert.equal(d.plan.id, String(p._id));
    assert.equal(d.plan.admissionId, String(p.admission));
    assert.deepEqual(d.plan.patient, { id: String(p.patient), name: p.patientName, uhid: p.patientUhid });
    assert.deepEqual([d.plan.bedLabel, d.plan.wardName, d.plan.doctor, d.plan.targetDay, d.plan.state, d.plan.status], [p.bedLabel, WARD_A, 'Dr. Shajin', TODAY, 'ordered', 'ordered']);

    const ov = d.order!;
    assert.equal(ov.id, String(o._id));
    assert.deepEqual([ov.kind, ov.state, ov.endedAs, ov.windowAt, ov.plannedLeaveAt, ov.windowOpen], ['home', 'ordered', undefined, iso(at(26, 11)), iso(at(26, 13)), true]);
    near(ov.leaveDueAt, at(26, 13));
    near(ov.summaryDueAt, at(26, 12));
    assert.deepEqual(ov.takeHomeOrderIds, [String(takeHome), String(added)]);
    assert.deepEqual(ov.followUp, { followUpId: 'f-1', status: 'booked', appointmentId: 'ap-1', date: '2026-10-03', time: '10:00' });
    assert.deepEqual(ov.followUpLater, [String(lr3._id)]);
    assert.deepEqual([ov.done, ov.required, ov.waitingOn, ov.waitingKey], [4, 7, 'Summary signed', 'summary']);
    assert.deepEqual(
      ov.lines.map((l) => [l.key, l.label, l.owner, l.rule, l.state]),
      [
        ['order', 'Discharge order', 'doctor', 'R', 'done'],
        ['summary', 'Summary signed', 'doctor', 'R', 'waiting'],
        ['lab', 'Lab results', 'lab', 'R', 'waiting'],
        ['take-home', 'Take-home medicines', 'pharmacy', 'R', 'done'],
        ['follow-up', 'Follow-up', 'scheduling', 'R', 'done'],
        ['teaching', 'Teaching and documents', 'nurse', 'R', 'done'],
        ['bill', 'Nothing due on the bill', 'revenue', 'R', 'waiting'],
      ],
    );
    assert.deepEqual(ov.lines[5], {
      key: 'teaching', label: 'Teaching and documents', owner: 'nurse', rule: 'R', state: 'done', by: NURSE, at: iso(at(26, 10)), note: 'Inhaler technique shown',
    });
    assert.equal(ov.lines[2].detail, '1 critical result to acknowledge · 1 result waiting');
    assert.equal(ov.gatePass, undefined);

    const sv = d.summary!;
    assert.equal(sv.id, String(s._id));
    assert.equal(sv.orderId, String(o._id));
    assert.equal(sv.title, 'Discharge summary');
    assert.equal(sv.updatedAt, iso(stored.updatedAt), 'the editor sends it back as seen (R38)');
    assert.equal(sv.sections.note, 'Walk daily.');
    assert.deepEqual([sv.course.source, sv.sample, sv.signedAt, sv.reopened], ['ai-sample', true, undefined, false]);
    assert.deepEqual(
      sv.layout.map((x) => x.key),
      ['details', 'reason', 'diagnosis', 'course', 'note', 'procedures', 'results', 'condition', 'medicines', 'followUp', 'warningSigns'],
    );

    assert.deepEqual(d.labRequests, [
      { id: String(lr1._id), number: 'LR-0001', waiting: 1, critical: false, followUpLater: false },
      { id: String(lr2._id), number: 'LR-0002', waiting: 0, critical: true, followUpLater: false },
      { id: String(lr3._id), number: 'LR-0003', waiting: 1, critical: false, followUpLater: true },
    ]);

    // A plan with no order: the plan alone, its lab requests still read from the case.
    const bare = await plan(TOMORROW, { case: otherCase._id });
    const b = await overview.detail(String(bare._id));
    assert.deepEqual([b.order, b.summary, b.plan.status, b.plan.caseId], [undefined, undefined, 'due-tomorrow', String(otherCase._id)]);
    assert.deepEqual(b.labRequests.map((r) => r.number), ['LR-0004']);

    await assert.rejects(overview.detail(String(new Types.ObjectId())), NotFoundException);
    await assert.rejects(overview.detail('nope'), NotFoundException);
    await assert.rejects(overview.byAdmission(String(new Types.ObjectId())), NotFoundException);
  });

  test('patientLine is null for a patient with no active plan', async () => {
    const ordered = await stay(TODAY, { lines: linesOf('home', ['order', 'summary', 'lab', 'take-home', 'follow-up']) });
    assert.deepEqual(await overview.patientLine(String(ordered.plan.patient)), {
      planId: String(ordered.plan._id),
      orderId: String(ordered.order._id),
      status: 'ordered',
      done: 5,
      required: 7,
      kind: 'home',
      plannedLeaveAt: iso(at(26, 13)),
    });
    const planned = await stay(TOMORROW);
    assert.deepEqual(await overview.patientLine(String(planned.plan.patient)), { planId: String(planned.plan._id), status: 'due-tomorrow', done: 0, required: 0 });

    const left = await gone({ windowAt: at(26, 8), leftAt: at(26, 9) });
    assert.equal(await overview.patientLine(String(left.plan.patient)), null, 'the stay is complete');
    assert.equal(await overview.patientLine(String(new Types.ObjectId())), null, 'no plan at all');
    assert.equal(await overview.patientLine('nope'), null);
  });

  // ---------- left today ----------

  test('left today marks an over-target discharge', async () => {
    const onTime = await gone({ windowAt: at(26, 8), leftAt: at(26, 9, 30), gatePass: { number: 'GP-0001', printedAt: [at(26, 9, 20)], by: NURSE } });
    const late = await gone({ windowAt: at(26, 8), leftAt: at(26, 10, 30), gatePass: { number: 'GP-0002', printedAt: [at(26, 10, 20), at(26, 10, 25)], by: NURSE } });
    await gone({ windowAt: at(25, 8), leftAt: at(25, 9) }); // yesterday
    const signed = await m.DischargeSummary.create({
      order: onTime.order._id, kind: 'home', course: { text: 'Recovered.', source: 'staff' }, signedBy: DOCTOR, signedAt: at(26, 9),
    });
    await m.DischargeSummary.create({ order: late.order._id, kind: 'home', course: { text: 'Recovered.', source: 'staff' } }); // not signed

    const rows = await overview.leftToday();
    assert.deepEqual(ids(rows), [String(late.plan._id), String(onTime.plan._id)], 'newest first');
    const [l, t] = rows;
    assert.deepEqual(
      { minutes: l.minutes, overTarget: l.overTarget, kind: l.kind, label: l.label, leftAt: l.leftAt, gatePass: l.gatePass, summaryId: l.summaryId },
      { minutes: 150, overTarget: true, kind: 'home', label: 'Home', leftAt: iso(at(26, 10, 30)), gatePass: { number: 'GP-0002', printedAt: [iso(at(26, 10, 20)), iso(at(26, 10, 25))] }, summaryId: undefined },
    );
    assert.deepEqual(
      { orderId: t.orderId, minutes: t.minutes, overTarget: t.overTarget, summaryId: t.summaryId, windowAt: t.windowAt },
      { orderId: String(onTime.order._id), minutes: 90, overTarget: false, summaryId: String(signed._id), windowAt: iso(at(26, 8)) },
    );
    assert.deepEqual(t.patient, { id: String(onTime.plan.patient), name: onTime.plan.patientName, uhid: onTime.plan.patientUhid });
    assert.equal(t.bedLabel, onTime.plan.bedLabel);
    assert.equal((await overview.overview()).cards.orderToLeaving.value, 120);
  });

  test('a Left without discharge is listed but not timed, and a death as Died (Body released)', async () => {
    // An order ended by Left without discharge: 180 minutes from its window, which would be over the target.
    const lwd = await gone({ windowAt: at(26, 6), leftAt: at(26, 9), endedAs: 'left-without-discharge' }, {
      leftWithoutDischarge: { reason: 'Not in bed at the round', lastSeenAt: at(26, 9), by: NURSE, at: at(26, 9, 30) },
    });
    // No order: last seen last night, recorded this morning.
    const noOrder = await plan(TODAY, {
      state: 'completed',
      completedAt: at(25, 22),
      completedKind: 'left-without-discharge',
      leftWithoutDischarge: { reason: 'Gone at the night round', lastSeenAt: at(25, 22), by: NURSE, at: at(26, 7) },
    });
    const died = await gone({ kind: 'died', windowAt: at(26, 9), leftAt: at(26, 10) });

    const rows = await overview.leftToday();
    assert.deepEqual(ids(rows), [String(died.plan._id), String(lwd.plan._id), String(noOrder._id)]);
    const [d, l, n] = rows;
    assert.deepEqual([d.kind, d.label, d.minutes, d.overTarget], ['died', 'Died (Body released)', 60, false]);
    assert.deepEqual([l.kind, l.label, l.minutes, l.overTarget, l.orderId], ['left-without-discharge', 'Left without discharge', null, false, String(lwd.order._id)]);
    assert.deepEqual([n.kind, n.minutes, n.overTarget, n.orderId, n.leftAt, n.windowAt], ['left-without-discharge', null, false, null, iso(at(25, 22)), null]);

    const o = await overview.overview();
    assert.equal(o.cards.orderToLeaving.value, 60, 'only the death is timed');
    assert.equal(o.cards.bedsFreeingToday.value, 3);
  });

  // ---------- snapshots ----------

  test('snapshot twice in one hour stores one', async () => {
    await stay(TODAY);
    await stay(TODAY, {});
    await stay(TODAY, { state: 'ready', lines: linesOf('home', HOME_REQUIRED) });
    await gone({ windowAt: at(26, 8), leftAt: at(26, 9, 30) });
    const hour = hourOf(NOW);
    // Yesterday's reading at this hour, and the one an hour ago.
    await m.DischargeSnapshot.create({ at: new Date(hour.getTime() - DAY), counts: { dueToday: 2, noOrder: 1, clearing: 2, ready: 0, leftToday: 1, avgMinutes: 60, bedsFreeing: 2 } });
    await m.DischargeSnapshot.create({ at: new Date(hour.getTime() - HOUR), counts: { dueToday: 3, noOrder: 1, clearing: 1, ready: 1, leftToday: 1, avgMinutes: 90, bedsFreeing: 3 } });

    assert.equal(await overview.snapshot(), true);
    assert.equal(await overview.snapshot(new Date(NOW.getTime() + 5 * MIN)), false, 'the same hour again stores nothing');
    const rows = await m.DischargeSnapshot.find({ at: hour }).lean<any[]>();
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { ...rows[0].counts },
      { dueToday: 3, noOrder: 1, clearing: 1, ready: 1, leftToday: 1, avgMinutes: 90, bedsFreeing: 3 },
    );
    assert.equal(await overview.snapshot(new Date(hour.getTime() + HOUR + 5 * MIN)), true, 'the next hour stores a row');
    assert.equal(await m.DischargeSnapshot.countDocuments(), 4);
    await m.DischargeSnapshot.deleteOne({ at: new Date(hour.getTime() + HOUR) });

    // The sparks read the last 24 hours, and the trend is against this hour yesterday.
    const o = await overview.overview();
    assert.deepEqual(o.cards.dueToday.spark.slice(-3), [null, 3, 3]);
    assert.equal(o.cards.dueToday.spark.length, 24);
    assert.equal(o.cards.dueToday.trendPct, 50);
    assert.equal(o.cards.ready.trendPct, null, 'nothing to compare with yesterday');
    assert.deepEqual(o.cards.orderToLeaving.spark.slice(-2), [90, 90]);
    assert.equal(o.cards.orderToLeaving.trendPct, 50);
    assert.deepEqual(o.cards.bedsFreeingToday.spark.slice(-2), [3, 3]);
  });

  // ---------- the day summary ----------

  test('the day summary input has no names', async () => {
    const { p, calls } = stubProvider('claude', { text: 'Most discharges today are waiting on the bill.' });
    overview = new DischargeOverviewService(
      settings, cases, aiOf(p), m.DischargePlan, m.DischargeOrder, m.DischargeSummary, m.DischargeSnapshot, m.LabRequest, m.LabLine,
    );
    overview.clock = () => NOW;
    const stays = [
      await stay(TODAY),
      // The longest wait: window open since 09:00, everything done but the bill.
      await stay(TODAY, { windowAt: at(26, 9), lines: linesOf('home', HOME_REQUIRED.filter((k) => k !== 'bill')) }),
      await stay(TODAY, { windowAt: at(26, 10) }),
      // Ready since earlier: not held on any line.
      await stay(TODAY, { state: 'ready', windowAt: at(26, 8), lines: linesOf('home', HOME_REQUIRED) }),
      // Not open yet.
      await stay(TODAY, { windowAt: at(26, 14), plannedLeaveAt: at(26, 16) }),
      await gone({ windowAt: at(26, 8), leftAt: at(26, 9, 40) }),
    ];

    const r = await overview.daySummary();
    assert.deepEqual(r, { text: 'Most discharges today are waiting on the bill.', sample: false, source: 'ai' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].input, {
      dueToday: 5, noOrder: 1, clearing: 3, ready: 1, leftToday: 1, avgMinutes: 100, targetMinutes: 120, longestWait: { line: 'Nothing due on the bill', minutes: 137 },
    });
    const sent = JSON.stringify(calls[0].input);
    for (const s of stays) {
      for (const v of [s.plan.patientName, s.plan.patientUhid, s.plan.bedLabel, String(s.plan._id), String(s.plan.patient), String(s.plan.admission), ...(s.order ? [String(s.order._id)] : [])]) {
        assert.ok(!sent.includes(v), `"${v}" reached the AI`);
      }
      for (const word of s.plan.patientName.split(' ')) assert.ok(!sent.includes(word), `"${word}" reached the AI`);
    }
    for (const v of [WARD_A, 'Shajin', DIAGNOSIS]) assert.ok(!sent.includes(v), `"${v}" reached the AI`);

    // With the AI off, the rules' sentence reads naturally and names no one either.
    (overview as any).ai = aiOf(stubProvider('none').p);
    const rules = await overview.daySummary();
    assert.equal(rules.source, 'rules');
    assert.equal(
      rules.text,
      '5 due today (1 with no order yet); 3 clearing; 1 ready to leave; 1 left today, 100 min on average from order to leaving (target 120 min); the longest wait is 137 min, waiting on the bill.',
    );
  });
});
