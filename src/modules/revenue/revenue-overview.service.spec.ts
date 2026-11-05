import * as assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { hourOf } from '../../common/utils/series';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AiProvider } from '../ai/ai-provider';
import { AiProviderName } from '../ai/ai-types';
import { AiService } from '../ai/ai.service';
import { RevenueAiService, leaks, templateExplain, templateSummary, validateText } from './revenue-ai';
import { RevenueOverviewService } from './revenue-overview.service';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const DAY_ISO = '2026-10-20';
const PATIENT = 'Mohan Raj';
const UHID = 'MHK202600970';
const FREE_LINE = 'Stent for Latha, wife of Mohan';
const REASON = 'patient asked for a discount because chest pain';
const BY = { id: 'u1', name: 'Front Desk' };

/** A provider that records exactly what the AI client is handed. */
function stubProvider(name: AiProviderName, answer: unknown = { text: 'Charges are mostly bed and procedure; a small balance remains.' }) {
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
const aiService = (p: AiProvider) => new AiService(p, { getSettings: async () => ({ ai: { revenueExplain: true, revenueSummary: true } }) } as any, { get: () => 50 } as any);

describe('RevenueOverviewService', () => {
  const m = models();
  let saved: string | undefined;
  let seq = 0;
  let patient: Types.ObjectId;

  const build = (ai: AiService) => new RevenueOverviewService(m.RevenueSnapshot, m.Bill, m.ChargeLine, m.Payment, m.Refund, m.TaskAlertItem, new RevenueAiService(ai));
  const svc = (kind: AiProviderName = 'none') => build(aiService(stubProvider(kind).p));
  const nowClinic = () => {
    const d = new Date();
    d.setFullYear(2026, 9, 20);
    return d;
  };

  const bill = async (over: Record<string, unknown> = {}) => {
    const n = ++seq;
    return m.Bill.create({ number: `BL-${String(n).padStart(4, '0')}`, patient, patientUhid: UHID, patientName: PATIENT, kind: 'er', state: 'open', openedAt: nowClinic(), erVisit: new Types.ObjectId(), totals: { charges: 0, discounts: 0, payments: 0, refunds: 0, balance: 0 }, ...over });
  };
  const pay = (b: any, amount: number, mode: string, over: Record<string, unknown> = {}) => {
    const n = ++seq;
    return m.Payment.create({ receiptNumber: `RC-${String(n).padStart(4, '0')}`, bill: b._id, amount, mode, kind: 'part', by: BY, at: nowClinic(), ...over });
  };
  const line = (b: any, over: Record<string, unknown> = {}) => {
    const n = ++seq;
    return m.ChargeLine.create({ bill: b._id, code: 'other:x', name: 'Charge', category: 'other', qty: 1, unitPrice: 100, amount: 100, source: { type: 'manual', ref: `r${n}` }, chargedAt: nowClinic(), by: BY, ...over });
  };
  const task = (b: any, kind: string, over: Record<string, unknown> = {}) =>
    m.TaskAlertItem.create({ title: `${kind} task`, subtitle: 'x', patientName: PATIENT, uhid: UHID, type: 'System', category: 'System', priority: 'Medium', status: 'Pending', link: `revenue-bill:${String(b._id)}:${kind}`, ...over });
  const refund = (b: any, state: string, amount = 500) => {
    const n = ++seq;
    return m.Refund.create({ number: `RF-${String(n).padStart(4, '0')}`, bill: b._id, amount, state, waiting: state === 'requested' || state === 'approved' });
  };

  before(async () => {
    await connectTestDb();
    saved = process.env.CLINIC_DATE;
    process.env.CLINIC_DATE = DAY_ISO;
  });
  after(async () => {
    if (saved === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = saved;
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    seq = 0;
    patient = new Types.ObjectId();
  });
  afterEach(() => undefined);

  test("overview counts today's collections by mode and open, due, final and refund bills", async () => {
    const a = await bill();
    const b = await bill({ kind: 'admission', admission: new Types.ObjectId(), erVisit: undefined, state: 'final', totals: { charges: 5000, discounts: 0, payments: 1000, refunds: 0, balance: 4000 } });
    const c = await bill({ state: 'final', erVisit: new Types.ObjectId(), totals: { charges: 800, discounts: 0, payments: 800, refunds: 0, balance: 0 } });
    const d = await bill({ state: 'settled', erVisit: new Types.ObjectId() });
    await pay(a, 1000, 'cash');
    await pay(a, 2500, 'upi');
    await pay(b, 700, 'card');
    await pay(b, 300, 'cash');
    await pay(a, 9999, 'cash', { cancelled: { at: new Date(), by: BY, reason: 'wrong bill' } });
    await pay(c, 4000, 'upi', { at: new Date(nowClinic().getTime() - DAY) });
    await task(a, 'deposit');
    await task(b, 'final');
    await task(b, 'topup');
    await task(c, 'deposit', { status: 'Completed' });
    await refund(a, 'approved', 600);
    await refund(d, 'requested', 100);
    await refund(c, 'paid', 50);
    await refund(b, 'rejected', 50);

    const o = await svc().overview();
    assert.equal(o.day, DAY_ISO);
    assert.equal(o.cards.collectedToday.value, 4500);
    assert.equal(o.cards.collectedToday.display, '₹4,500');
    assert.deepEqual(o.byMode, { cash: 1300, upi: 2500, card: 700, kiosk: 0 });
    assert.equal(o.cards.openBills.value, 2, 'open a, final b with a balance; not final c at zero, not settled d');
    assert.equal(o.cards.depositsDue.value, 1);
    assert.equal(o.cards.finalWaiting.value, 1);
    assert.equal(o.cards.refundsDue.value, 1, 'only an approved, unpaid refund');
    for (const k of Object.keys(o.cards)) assert.equal(o.cards[k as keyof typeof o.cards].spark.length, 24);
    assert.equal(o.recent.length, 6, 'the cancelled payment is listed, marked cancelled');
    assert.equal(o.recent.filter((p: any) => p.cancelled).length, 1);
  });


  test('payments taken at the reception kiosk count in the collections by mode', async () => {
    const b = await bill({ kind: 'walk-in', erVisit: undefined, day: DAY_ISO });
    await pay(b, 300, 'kiosk', { kind: 'settlement', source: 'op-visit:v1' });
    await pay(b, 200, 'cash');
    const o = await svc().overview();
    assert.equal(o.cards.collectedToday.value, 500);
    assert.deepEqual(o.byMode, { cash: 200, upi: 0, card: 0, kiosk: 300 });
  });
  test('needsAction lists bills with a deposit, top-up, final or refund task, oldest first; needsPrice and recent follow the brief', async () => {
    const a = await bill();
    const b = await bill({ kind: 'admission', admission: new Types.ObjectId(), erVisit: undefined });
    const t = (min: number) => new Date(Date.now() - min * MIN);
    const t1 = await task(a, 'final');
    const t2 = await task(b, 'deposit');
    const rf = await refund(a, 'approved');
    const t3 = await m.TaskAlertItem.create({ title: 'Pay refund', subtitle: 'x', patientName: PATIENT, uhid: UHID, type: 'System', category: 'System', priority: 'Medium', status: 'Pending', link: `revenue-refund:${String(rf._id)}` });
    await m.TaskAlertItem.collection.updateOne({ _id: t1._id }, { $set: { createdAt: t(30) } });
    await m.TaskAlertItem.collection.updateOne({ _id: t2._id }, { $set: { createdAt: t(50) } });
    await m.TaskAlertItem.collection.updateOne({ _id: t3._id }, { $set: { createdAt: t(10) } });
    await line(a, { needsPrice: true, code: 'cons:stent-des', name: 'Stent', unitPrice: 0, amount: 0 });
    await line(a);
    for (let i = 0; i < 22; i++) await pay(a, 10 + i, 'cash', { at: new Date(nowClinic().getTime() - i * MIN) });

    const o = await svc().overview();
    assert.deepEqual(o.needsAction.map((r: any) => r.need), ['deposit', 'final', 'refund']);
    assert.equal(o.needsAction[0].number, b.number);
    assert.equal(o.needsAction[2].number, a.number, 'the refund task points at its bill');
    assert.equal(o.needsPrice.length, 1);
    assert.equal(o.needsPrice[0].billNumber, a.number);
    assert.equal(o.needsPrice[0].code, 'cons:stent-des');
    assert.equal(o.recent.length, 20);
    assert.ok(o.recent[0].at >= o.recent[19].at, 'latest first');
  });

  test('a bad day is refused', async () => {
    await assert.rejects(() => svc().overview('20-10-2026'));
  });

  test('explain for an unknown bill is a 404', async () => {
    await assert.rejects(() => svc().explain(String(new Types.ObjectId())), NotFoundException);
  });

  /** One bill carrying every identifying value the AI must never see. */
  const leakyBill = async () => {
    const b = await bill({ number: 'BL-0042', totals: { charges: 12000, discounts: 500, payments: 4000, refunds: 0, balance: 7500 } });
    await line(b, { code: 'bed:icu', name: FREE_LINE, category: 'bed', unitPrice: 6000, qty: 1, amount: 6000, reason: REASON });
    await line(b, { code: 'proc:coronary-angiography', name: FREE_LINE, category: 'procedure', unitPrice: 6000, amount: 6000, reason: REASON });
    await pay(b, 4000, 'upi', { receiptNumber: 'RC-0007', reference: 'UTR 123456789012' });
    await refund(b, 'approved', 100);
    await m.Refund.updateOne({ bill: b._id }, { $set: { number: 'RF-0003' } });
    return b;
  };
  const secrets = [PATIENT, 'Mohan', 'Raj', UHID, 'MHK', 'BL-0042', 'RC-0007', 'RF-0003', 'BL-', 'RC-', 'RF-', FREE_LINE, 'Latha', 'Stent', 'wife', REASON, 'discount because', 'chest pain', 'UTR', '123456789012', 'Front Desk'];

  test('the AI input for explain holds category totals and counts only — no name, UHID, number or free text', async () => {
    const b = await leakyBill();
    const blobs: string[] = [];
    let first: any;
    for (const mode of ['sample', 'claude'] as const) {
      const { p, calls } = stubProvider(mode);
      const real = aiService(p);
      const spy: any[] = [];
      const orig = real.runStructured.bind(real);
      (real as any).runStructured = (t: any) => {
        spy.push({ instructions: t.instructions, input: t.input });
        return orig(t);
      };
      await build(real).explain(String(b._id));
      assert.equal(spy.length, 1);
      if (mode === 'claude') assert.equal(calls.length, 1, 'the client got the same payload');
      blobs.push(...spy.map((x) => JSON.stringify(x)), ...calls.map((x) => JSON.stringify(x)));
      first ??= spy[0].input;
    }
    for (const blob of blobs) {
      for (const s of secrets.concat(String(b._id), String(patient))) assert.ok(!blob.includes(s), `leaked ${s}`);
      assert.ok(!leaks(blob), 'the leak check passes on the whole payload');
      assert.ok(!/\b[a-f\d]{24}\b/i.test(blob) && !/\d{9,}/.test(blob));
    }
    assert.deepEqual(first.categoryTotals, { bed: 6000, procedure: 6000 });
    assert.deepEqual(first.lineCountsByCategory, { bed: 1, procedure: 1 });
    assert.deepEqual(first.procedures, [{ label: 'Coronary angiography', amount: 6000 }]);
    assert.deepEqual(first.totals, { charges: 12000, discounts: 500, payments: 4000, refunds: 0, balance: 7500 });
    assert.deepEqual(first.paymentsByMode, { upi: 4000 });
  });

  test('a reversed procedure never reaches the AI explanation, and its amounts agree with the bill', async () => {
    const b = await bill({ totals: { charges: 6000, discounts: 0, payments: 0, refunds: 0, balance: 6000 } });
    await line(b, { code: 'bed:icu', category: 'bed', unitPrice: 6000, amount: 6000 });
    // What CorrectionsService leaves after a reversal: the original marked reversed and a negative credit line in its category.
    await line(b, { code: 'proc:coronary-angiography', category: 'procedure', unitPrice: 6000, amount: 6000, reversed: true });
    await line(b, { code: 'correction:reversal', name: 'Reversal: Procedure', category: 'procedure', unitPrice: -6000, amount: -6000 });
    const { p, calls } = stubProvider('claude');
    await build(aiService(p)).explain(String(b._id));
    const input = calls[0].input as any;
    assert.deepEqual(input.procedures, []);
    assert.ok(!JSON.stringify(input).includes('Coronary angiography'));
    assert.equal(Object.values(input.categoryTotals as Record<string, number>).reduce((a, v) => a + v, 0), input.totals.charges);
    assert.equal(input.categoryTotals.procedure, 0);
  });

  test('the leak check catches each pattern, and a leaking answer is refused', async () => {
    for (const bad of ['BL-0042 owes', 'receipt RC-0007', 'RF-0003 paid', 'ER-0012 arrived', 'LR-0004', 'MO-0009', 'MHK202600970', 'call 9100000070', '507f1f77bcf86cd799439011', 'PR-0001', 'CO-0002', 'CASE-12', 'Dr. Arun']) {
      assert.ok(leaks(bad), bad);
      assert.equal(validateText({ text: bad }), null, bad);
    }
    for (const ok of ['Charges ₹1,23,456; paid ₹4,000.', 'bed ₹6,000, procedure ₹6,000', 'balance due ₹7,500']) assert.ok(!leaks(ok), ok);
    assert.deepEqual(validateText({ text: '  fine  ' }), { text: 'fine' });
    assert.equal(validateText({ text: 'x'.repeat(501) }), null);
    assert.equal(validateText({ text: '' }), null);
    // a leaky input (an identifier-looking label) sends nothing and falls back
    const { p, calls } = stubProvider('claude');
    const r = await new RevenueAiService(aiService(p)).explain({ categoryTotals: {}, lineCountsByCategory: {}, totals: { charges: 1, discounts: 0, payments: 0, refunds: 0, balance: 1 }, paymentsByMode: {}, procedures: [{ label: 'BL-0042', amount: 1 }] });
    assert.equal(calls.length, 0);
    assert.equal(r.source, 'rules');
  });

  test('the fallback sentences are built from the numbers alone', async () => {
    const t = templateExplain({ categoryTotals: { bed: 6000, procedure: 6000 }, lineCountsByCategory: { bed: 1, procedure: 1 }, procedures: [{ label: 'Coronary angiography', amount: 6000 }], totals: { charges: 12000, discounts: 500, payments: 4000, refunds: 0, balance: 7500 }, paymentsByMode: { upi: 4000 } });
    assert.match(t, /₹12,000/);
    assert.match(t, /bed ₹6,000/);
    assert.match(t, /₹4,000/);
    assert.match(t, /₹7,500/);
    const s = templateSummary({ collectedToday: 4500, byMode: { cash: 1300, upi: 2500, card: 700 }, openBills: 2, depositsDue: 1, finalWaiting: 1, refundsDue: 1, needsPriceLines: 3, openBillsByKind: { er: 1, admission: 1 }, outstandingBalance: 4000 });
    assert.match(s, /₹4,500/);
    assert.match(s, /2 open bills/);
    assert.match(s, /3 lines? need a price/);
  });

  test('the summary input holds totals and counts only', async () => {
    const b = await leakyBill();
    await task(b, 'deposit');
    const { p, calls } = stubProvider('claude');
    const real = aiService(p);
    await build(real).summarise();
    assert.equal(calls.length, 1);
    const blob = JSON.stringify(calls[0]);
    for (const s of secrets.concat(String(b._id), String(patient))) assert.ok(!blob.includes(s), `leaked ${s}`);
    assert.ok(!leaks(blob));
    assert.deepEqual(Object.keys(calls[0].input).sort(), ['byMode', 'collectedToday', 'depositsDue', 'finalWaiting', 'needsPriceLines', 'openBills', 'openBillsByKind', 'outstandingBalance', 'refundsDue']);
    assert.equal((calls[0].input as any).collectedToday, 4000);
  });

  test('the sample summary is marked sample', async () => {
    const b = await bill({ totals: { charges: 1000, discounts: 0, payments: 400, refunds: 0, balance: 600 } });
    await pay(b, 400, 'cash');
    const sample = await svc('sample').summarise();
    assert.equal(sample.sample, true);
    assert.equal(sample.source, 'ai');
    assert.match(sample.text, /₹400/);
    const off = await svc('none').summarise();
    assert.deepEqual([off.sample, off.source], [false, 'rules']);
    assert.equal(off.text, sample.text, 'the same fixed sentence');
    const bad = await build(aiService(stubProvider('claude', { text: `See ${UHID}` }).p)).summarise();
    assert.equal(bad.source, 'rules');
    const good = await build(aiService(stubProvider('claude').p)).summarise();
    assert.deepEqual([good.source, good.sample], ['ai', false]);
    const ex = await build(aiService(stubProvider('sample').p)).explain(String(b._id));
    assert.deepEqual([ex.sample, ex.source], [true, 'ai']);
  });

  test('snapshots store the hour once, feed the trend and fill a 168-point series with gaps as null', async () => {
    const a = await bill();
    await pay(a, 1500, 'cash');
    await task(a, 'deposit');
    const s = svc();
    await s.snapshot();
    await s.snapshot();
    assert.equal(await m.RevenueSnapshot.countDocuments(), 1);
    const snap = await m.RevenueSnapshot.findOne().lean();
    assert.equal(snap!.collected, 1500);
    assert.equal(snap!.openBills, 1);
    assert.equal(snap!.depositsDue, 1);
    const dayAgo = hourOf(new Date(Date.now() - DAY));
    await m.RevenueSnapshot.create({ at: dayAgo, collected: 1000, openBills: 4, depositsDue: 0, finalWaiting: 0, refundsDue: 0 });
    const o = await s.overview();
    assert.equal(o.cards.collectedToday.trendPct, 50);
    assert.equal(o.cards.openBills.trendPct, -75);
    assert.equal(o.cards.depositsDue.trendPct, null);
    assert.equal(o.cards.collectedToday.spark.length, 24);
    assert.equal(o.cards.collectedToday.spark[23], 1500);
    assert.equal(o.cards.collectedToday.spark[0], null, 'the sparkline starts 23 hours back, the trend compares 24 hours back');
    const week = await s.series('7d');
    assert.equal(week.points.length, 168);
    assert.equal(week.points[167].collectedToday, 1500);
    assert.equal(week.points[167].openBills, 1);
    assert.equal(week.points[166].collectedToday, null);
    assert.equal(week.points[168 - 25].collectedToday, 1000);
    assert.equal((await s.series('24h')).points.length, 24);
  });
});
