import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { hourOf } from '../../common/utils/series';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AiProvider } from '../ai/ai-provider';
import { AiProviderName } from '../ai/ai-types';
import { AiService } from '../ai/ai.service';
import { UserRole } from '../users/schemas/user.schema';
import { SupportAiService } from './support-ai';
import { SupportFeedbackService } from './support-feedback.service';
import { SupportOverviewService } from './support-overview.service';
import { SupportTicketsService } from './support-tickets.service';

const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (h: number, min = 0, day = 26) => new Date(2026, 8, day, h, min, 0, 0);
/** Not on an hour or half hour, so the spark's last bucket is a part hour in every zone. */
const NOW = at(14, 17);
const admin = { id: 'u-admin', name: 'Admin', role: UserRole.ADMIN };
const desk = { id: 'u-desk', name: 'Anita Desk', role: UserRole.STAFF };

function stubProvider(name: AiProviderName, answer: unknown = { text: 'A steady day at the desk.' }) {
  const calls: { instructions: string; input: Record<string, unknown> }[] = [];
  const p: AiProvider = {
    name,
    model: 'm',
    complete: async (req) => {
      calls.push({ instructions: req.instructions, input: req.input });
      return answer;
    },
    check: async () => ({ ok: true, detail: 'fine' })
  };
  return { p, calls };
}
const aiOf = (p: AiProvider) => new SupportAiService(new AiService(p, { getSettings: async () => ({ ai: {} }) } as any, { get: () => 50 } as any));

describe('SupportOverviewService', () => {
  const m = models();
  let overview: SupportOverviewService;
  let seq: number;

  const build = (ai: SupportAiService) => {
    const tickets = Object.create(SupportTicketsService.prototype) as SupportTicketsService;
    tickets.now = () => NOW;
    const feedback = new SupportFeedbackService(null as any, null as any, null as any, m.SupportFeedback, m.Patient);
    return new SupportOverviewService(
      tickets,
      feedback,
      ai,
      m.SupportTicket,
      m.PatientUpdate,
      m.CheckupCall,
      m.SupportFeedback,
      m.SupportTemplate,
      m.SupportFaq
    );
  };

  const ticket = (openedAt: Date, extra: Record<string, unknown> = {}) => {
    const n = seq++;
    return m.SupportTicket.create({
      number: `SP-${String(n).padStart(4, '0')}`,
      callerName: 'A caller',
      ticketType: 'billing',
      owner: 'patient-relations',
      ladder: 'support-desk',
      priority: 'normal',
      source: 'desk',
      channel: 'desk',
      question: 'A question',
      state: 'open',
      dueAt: new Date(openedAt.getTime() + 4 * HOUR),
      openedById: 'u-desk',
      openedByName: 'Anita Desk',
      openedAt,
      ...extra
    });
  };
  /** `updatedAt` is stamped by Mongoose with the real clock, so it is set afterwards (default: NOW). */
  const update = async (status: string, extra: Record<string, unknown> = {}) => {
    const n = seq++;
    const doc = await m.PatientUpdate.create({
      patient: new Types.ObjectId(),
      patientUhid: `MHK2026${n}`,
      patientName: 'Ravi Kumar',
      trigger: 'admitted',
      dedupeKey: `k${n}`,
      template: 'admitted',
      status,
      ...extra
    });
    await m.PatientUpdate.collection.updateOne({ _id: doc._id }, { $set: { updatedAt: NOW } });
    return doc;
  };
  const checkup = (state: string, extra: Record<string, unknown> = {}) => {
    const n = seq++;
    return m.CheckupCall.create({
      number: `CU-${String(n).padStart(4, '0')}`,
      sourceKey: `discharge:${n}`,
      patient: new Types.ObjectId(),
      patientUhid: `MHK2026${n}`,
      patientName: 'Ravi Kumar',
      kind: 'home',
      leftAt: at(9, 0, 24),
      dueDay: '2026-09-26',
      group: 'general',
      state,
      ...extra
    });
  };
  const rating = (overall: number, when: Date) => m.SupportFeedback.create({ source: 'desk', overall, at: when, aspects: { staff: overall } });

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    seq = 1;
    overview = build(aiOf(stubProvider('sample').p));
  });

  test('the KPIs on a fixed set of tickets, updates and ratings', async () => {
    await ticket(at(8), { state: 'resolved', resolvedAt: at(9), answeredAt: at(8, 20), firstResponseMinutes: 20 });
    await ticket(at(9), { state: 'in-progress', answeredAt: at(9, 40), firstResponseMinutes: 40, roundAnsweredAt: at(9, 40) });
    await ticket(at(10), { escalatedAt: at(12), dueAt: at(11) });
    await ticket(at(11), { priority: 'urgent', channel: 'phone', ticketType: 'complaint' });
    await ticket(at(1, 0, 24), { state: 'waiting' });
    await update('sent', { sentAt: at(10) });
    await update('sample', { sentAt: at(12) });
    await update('sent', { sentAt: at(10, 0, 25) });
    await update('skipped', { reason: 'no-consent' });
    await update('held', { reason: 'auto-off' });
    await rating(5, at(9));
    await rating(4, at(12));
    await rating(2, at(10, 0, 22));

    const o = await overview.overview(admin, NOW);
    assert.deepEqual(o.kpis, { openTickets: 4, avgFirstResponseMin: 30, satisfaction7d: 3.7, escalated: 1 });
    assert.equal(o.cards.open.value, 4);
    assert.equal(o.cards.updatesToday.value, 2);
    assert.equal(o.cards.firstResponse.value, 30);
    assert.equal(o.cards.satisfaction.value, 3.7);
    assert.equal(o.cards.escalated.value, 1);
    assert.equal(o.cards.resolvedToday.value, 1);
    assert.equal(o.cards.open.total, null);
    assert.equal(o.cards.open.note, 'Not resolved');
    assert.deepEqual(o.todayCounts, { all: 4, open: 1, inProgress: 1, waiting: 0, resolved: 1, escalated: 1 });
    assert.equal(o.byType[0].type, 'billing');
    assert.equal(o.byType[0].count, 3);
    assert.equal(o.byType.length, 10);
    assert.deepEqual(o.channels, { phone: 1, desk: 3, updates: 2, checkups: 0 });
    assert.deepEqual(o.satisfaction.average, 3.7);
    assert.deepEqual([o.satisfaction.today, o.satisfaction.todayCount, o.satisfaction.count], [4.5, 2, 3]);
    assert.equal(o.recentFeedback.length, 3);
    assert.equal(o.flow.inquiries, 4);
    assert.equal(o.flow.updates, 2);
    assert.equal(o.flow.skipped, 1);
    assert.equal(o.flow.held, 1);
    // Queue: unresolved, urgent first then oldest. Today: newest first.
    assert.deepEqual(
      o.queue.map((r) => r.openedAt.getTime()),
      [at(11), at(1, 0, 24), at(9), at(10)].map((d) => d.getTime())
    );
    assert.equal(o.queue[0].priority, 'urgent');
    assert.deepEqual(
      o.today.map((r) => r.openedAt.getTime()),
      [at(11), at(10), at(9), at(8)].map((d) => d.getTime())
    );
    assert.equal(o.today.find((r) => r.escalatedAt)?.shown, 'Escalated');
  });

  test('the average first response leaves out on-the-spot tickets', async () => {
    await ticket(at(8), { answeredAt: at(8, 10), firstResponseMinutes: 10 });
    await ticket(at(9), { answeredAt: at(9, 50), firstResponseMinutes: 50 });
    await ticket(at(10), { onTheSpot: true, answeredAt: at(10), firstResponseMinutes: 0 });
    const o = await overview.overview(admin, NOW);
    assert.equal(o.kpis.avgFirstResponseMin, 30);
    const none = await resetTestDb().then(() => overview.overview(admin, NOW));
    assert.equal(none.kpis.avgFirstResponseMin, null);
    assert.equal(none.cards.firstResponse.value, null);
    assert.equal(none.kpis.satisfaction7d, null);
  });

  test('trendPct and a 24-point spark from records', async () => {
    // Placed relative to the spark's hour grid (UTC hours, so half-hour zones are covered too): H is the hour NOW is in.
    const H = hourOf(NOW).getTime();
    const rel = (hoursBack: number, plusMin = 0) => new Date(H - hoursBack * HOUR + plusMin * MIN);
    await ticket(rel(26, 5)); // open for the whole period
    await ticket(rel(4, 5)); // opened four hours ago
    await ticket(rel(0, 5)); // opened in the current part hour
    // Open 24 hours ago, resolved three hours ago.
    await ticket(rel(27), { state: 'resolved', resolvedAt: rel(3, 5), answeredAt: rel(3, 5), firstResponseMinutes: 1200 });
    const o = await overview.overview(admin, NOW);
    assert.equal(o.cards.open.value, 3);
    assert.equal(o.cards.open.trendPct, 50); // 2 open 24 hours ago
    assert.equal(o.cards.open.spark.length, 24);
    // Oldest first; a point is read at the end of its hour, the last at NOW.
    assert.equal(o.cards.open.spark[0], 2);
    assert.equal(o.cards.open.spark[18], 2);
    assert.equal(o.cards.open.spark[19], 3); // the ticket from four hours ago is open
    assert.equal(o.cards.open.spark[20], 2); // the resolved one has left
    assert.equal(o.cards.open.spark[22], 2);
    assert.equal(o.cards.open.spark[23], 3);
    // Nothing escalated 24 hours ago, nothing resolved the day before: no trends.
    assert.equal(o.cards.escalated.trendPct, null);
    assert.equal(o.cards.resolvedToday.value, 1);
    assert.equal(o.cards.resolvedToday.trendPct, null);
    assert.equal(o.cards.resolvedToday.spark.length, 24);
    assert.equal(o.cards.resolvedToday.spark[20], 1);
    assert.equal(
      o.cards.resolvedToday.spark.reduce<number>((a, b) => a + (b ?? 0), 0),
      1
    );
    // The first response in that bucket was not "today's" unless it happened today; the others have no answers: null points.
    assert.equal(o.cards.firstResponse.spark[0], null);
  });

  test('insights appear only when their count is above zero, at most five, and the Tamil one only for admins', async () => {
    const none = await overview.overview(admin, NOW);
    // Seeded texts are not loaded in this database, so nothing is to check yet.
    assert.deepEqual(none.insights, []);

    await ticket(at(8), { escalatedAt: at(12), dueAt: at(11) });
    await ticket(at(9), { ticketType: 'complaint' });
    await checkup('completed', { result: 'needs-doctor', at: at(10) });
    await checkup('due');
    await update('skipped', { reason: 'no-consent' });
    await update('held', { reason: 'auto-off' });
    await m.SupportTemplate.create({ key: 'admitted', trigger: 'admitted', en: 'Hello', ta: 'வணக்கம்', approved: true, taChecked: false });
    const o = await overview.overview(admin, NOW);
    assert.deepEqual(
      o.insights.map((i) => i.key),
      ['escalated', 'needs-doctor', 'checkups-to-do', 'no-consent', 'held']
    );
    assert.equal(o.insights.length, 5);
    assert.deepEqual(
      o.insights.map((i) => i.title),
      ['1 ticket past its target', '1 check-up call needs a doctor', '1 check-up call to do', '1 update skipped for no consent', '1 update held']
    );
    assert.deepEqual([o.insights[0].sub, o.insights[4].sub], ['Waiting for a first answer after its due time.', 'Waiting for a person to send it.']);
    assert.deepEqual(o.insights[0].action, { label: 'Open tickets', tab: 'tickets', filter: 'escalated' });
    assert.equal(o.insights[0].tone, 'red');
    assert.deepEqual(o.checkups, { due: 1, needsDoctor: 1, sentToEr: 0, comingUp: 0 });
    await ticket(at(8, 30), { escalatedAt: at(12), dueAt: at(11) });
    await checkup('completed', { result: 'needs-doctor', at: at(10, 30) });
    assert.deepEqual(
      (await overview.overview(admin, NOW)).insights.slice(0, 2).map((i) => i.title),
      ['2 tickets past their target', '2 check-up calls need a doctor']
    );

    // Without the escalation and the doctor check-up, the later rules show, and the Tamil one for an admin only.
    await m.SupportTicket.updateMany({}, { $unset: { escalatedAt: 1 } });
    await m.CheckupCall.updateMany({}, { $set: { reviewedAt: NOW } });
    await m.CheckupCall.deleteMany({ state: 'due' });
    await m.PatientUpdate.deleteMany({});
    const a = await overview.overview(admin, NOW);
    assert.deepEqual(
      a.insights.map((i) => [i.key, i.tone]),
      [
        ['complaints', 'violet'],
        ['tamil', 'blue']
      ]
    );
    assert.deepEqual(a.insights[1].action, { label: 'Open texts', tab: 'texts' });
    const d = await overview.overview(desk, NOW);
    assert.deepEqual(
      d.insights.map((i) => i.key),
      ['complaints']
    );
  });

  test("the day summary sends counts only and falls back to the rules' text", async () => {
    await ticket(at(8), { state: 'resolved', resolvedAt: at(9), ticketType: 'billing', callerName: 'Ravi Kumar', question: 'Where is my bill?' });
    await ticket(at(9));
    await update('sent', { sentAt: at(10) });
    await update('skipped', { reason: 'no-consent' });
    await checkup('completed', { result: 'fine', at: at(11) });
    await rating(4, at(9));

    // The sample provider answers with the rules' text and says so.
    const sample = await overview.daySummary(NOW);
    assert.deepEqual(sample, {
      text: 'Today: 2 questions, 1 resolved, 0 escalated; 1 family updates sent, 1 skipped; 1 check-up calls done.',
      sample: true,
      source: 'ai'
    });

    // A real provider: only the counts go out.
    const live = stubProvider('claude', { text: 'A steady day at the desk.' });
    const o2 = build(aiOf(live.p));
    const r = await o2.daySummary(NOW);
    assert.deepEqual([r.text, r.sample, r.source], ['A steady day at the desk.', false, 'ai']);
    assert.equal(live.calls.length, 1);
    assert.deepEqual(live.calls[0].input, {
      ticketsOpened: 2,
      ticketsResolved: 1,
      ticketsEscalated: 0,
      updatesSent: 1,
      updatesSkipped: 1,
      updatesHeld: 0,
      checkupsDone: 1,
      needsDoctor: 0,
      sentToEr: 0,
      averageRating: 4
    });
    const sent = JSON.stringify(live.calls[0]);
    for (const secret of ['Ravi', 'Where is my bill', 'MHK', 'SP-', 'CU-']) assert.ok(!sent.includes(secret), secret);

    // An answer with an identifier, or an AI that is off, gives the rules' text.
    const leaky = await build(aiOf(stubProvider('claude', { text: 'See SP-0001 for details.' }).p)).daySummary(NOW);
    assert.deepEqual([leaky.sample, leaky.source], [false, 'rules']);
    assert.match(leaky.text, /^Today: 2 questions/);
    const off = await build(aiOf(stubProvider('none').p)).daySummary(NOW);
    assert.deepEqual([off.sample, off.source], [false, 'rules']);
  });
});
