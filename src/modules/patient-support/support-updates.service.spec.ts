import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { BED_MESSAGE_TYPES } from '../beds/bed-coordinator.bridge';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { MessagesService } from '../coordinator/messages.service';
import { RulesService } from '../coordinator/rules.service';
import { DISCHARGE_MESSAGE_TYPES } from '../discharge/discharge-coordinator.registration';
import { REVENUE_MESSAGE_TYPES } from '../revenue/revenue-coordinator.registration';
import { SCHEDULING_MESSAGE_TYPES } from '../scheduling/scheduling-coordinator.registration';
import { procedureByKey } from '../scheduling/scheduling-catalogue';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { SupportRegistration } from './support-coordinator.registration';
import { SupportFactsService } from './support-facts.service';
import { MessageSender } from './support-sender';
import { SupportSettingsService } from './support-settings.service';
import { SupportTextsService } from './support-texts.service';
import { SupportUpdatesService } from './support-updates.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const DESK = { id: 'f1', name: 'Front Desk', role: UserRole.STAFF };
const NURSE = { id: 'n1', name: 'Nurse', role: UserRole.NURSE };
const at = (h: number, min = 0, day = 26) => new Date(2026, 8, day, h, min, 0, 0);
const oid = () => new Types.ObjectId();
/** Inserts a record without validation: the specs only need the fields the service reads. */
const raw = async (model: any, doc: Record<string, unknown>) => (await model.insertMany([doc], { lean: true }))[0];

describe('SupportUpdatesService', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let rules: RulesService;
  let settings: SettingsService;
  let reg: SupportRegistration;
  let texts: SupportTextsService;
  let facts: SupportFactsService;
  let svc: SupportUpdatesService;
  let calls: [string, string][];
  let sender: MessageSender;
  let now: Date;
  let savedClinicDate: string | undefined;
  let patient: any;
  let ward: any;
  let bed: any;
  let admission: any;
  const caseId = String(oid());

  const build = (s: MessageSender | null) => {
    const service = new SupportUpdatesService(
      reg,
      messages,
      texts,
      facts,
      new SupportSettingsService(settings),
      settings,
      rules,
      s,
      m.PatientUpdate,
      m.AgentMessage,
      m.Patient,
      m.Admission,
      m.ProcedureBooking,
      m.Bill,
      m.Appointment,
      m.FollowUpItem,
      m.DischargePlan,
      m.DischargeOrder,
      m.CoordinatorCounter
    );
    service.clock = () => now;
    return service;
  };
  const send = (from: string, type: string, payload: Record<string, unknown>, onCase: string | null = caseId) =>
    messages.send({ case: onCase, from: from as any, to: ['coordinator'], type, priority: 'medium', summary: `${type} (spec)`, payload });
  const assigned = () => send('bed', 'bed.assigned', { bedId: String(bed._id), bedLabel: bed.label, admissionId: String(admission._id), ward: ward.name });
  const updates = () => m.PatientUpdate.find().sort({ createdAt: 1, _id: 1 }).lean();
  const one = async () => {
    const all = await updates();
    assert.equal(all.length, 1);
    return all[0] as any;
  };
  const supportMessages = (type: string) => m.AgentMessage.find({ type }).lean();
  const consent = (messages_ = true) => m.Patient.updateOne({ _id: patient._id }, { $set: { consent: { messages: messages_, calls: false } } });
  const booking = (extra: Record<string, unknown> = {}) =>
    raw(m.ProcedureBooking, {
      number: 'PR-0001',
      patient: patient._id,
      patientUhid: 'MHK1',
      patientName: 'Asha K',
      case: new Types.ObjectId(caseId),
      procedure: 'coronary-angiography',
      priority: 'routine',
      status: 'booked',
      room: 'cath-1',
      start: at(8, 30, 28),
      end: at(10, 0, 28),
      ...extra
    });
  const bookedMessage = (b: any) =>
    send('scheduling', 'scheduling.procedure-booked', {
      bookingId: String(b._id),
      number: b.number,
      procedure: b.procedure,
      priority: 'routine',
      status: 'booked',
      room: 'cath-1',
      start: b.start,
      contrast: true
    });

  before(async () => {
    savedClinicDate = process.env.CLINIC_DATE;
    process.env.CLINIC_DATE = '2026-09-26';
    await connectTestDb();
  });
  after(async () => {
    if (savedClinicDate === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinicDate;
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    now = at(10, 0);
    registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    messages = new MessagesService(m.AgentMessage, registry, events);
    for (const [key, types] of [
      ['bed', BED_MESSAGE_TYPES],
      ['scheduling', SCHEDULING_MESSAGE_TYPES],
      ['revenue', REVENUE_MESSAGE_TYPES],
      ['discharge', DISCHARGE_MESSAGE_TYPES]
    ] as const)
      registry.register({ key: key as any, messageTypes: types as any, status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });
    settings = new SettingsService(m.HospitalSettings);
    await settings.updateSettings({ hospital: { name: "St. Mary's Hospital" } as any });
    rules = new RulesService(registry, settings, events);
    reg = new SupportRegistration(registry, messages, m.SupportTicket, m.CheckupCall);
    reg.onModuleInit();
    texts = new SupportTextsService(m.SupportTemplate, m.SupportFaq, settings, new SupportSettingsService(settings));
    await texts.ensureDefaults();
    facts = new SupportFactsService(
      m.Patient,
      m.Admission,
      m.Bed,
      m.Ward,
      m.ProcedureBooking,
      m.ErVisit,
      m.DischargeOrder,
      m.DischargePlan,
      m.Case,
      new TimelineService(m.TimelineEvent)
    );
    calls = [];
    sender = { name: 'sample', send: async (to, text) => (calls.push([to, text]), { ok: true }) };
    svc = build(sender);
    svc.onModuleInit();

    patient = await m.Patient.create({
      uhid: 'MHK1',
      name: 'Asha K',
      age: 40,
      gender: 'Female',
      phone: '9876543210',
      consent: { messages: true, calls: false }
    });
    ward = await raw(m.Ward, { code: 'GWA', name: 'General Ward A', shortName: 'Ward A', floor: 1, type: 'general', gender: 'any', ratePerDay: 800 });
    bed = await raw(m.Bed, { ward: ward._id, label: 'Ward A • Bed 4', number: 4, state: 'occupied' });
    admission = await raw(m.Admission, { patient: patient._id, patientUhid: 'MHK1', patientName: 'Asha K', bed: bed._id, status: 'active', sample: false });
  });

  test('bed.assigned makes one admitted update with ward, bed, floor and visiting hours; delivered twice still one', async () => {
    const msg = await assigned();
    const u = await one();
    assert.equal(u.trigger, 'admitted');
    assert.equal(u.dedupeKey, `admitted:${admission._id}`);
    assert.equal(u.status, 'waiting');
    assert.equal(u.sendAt.getTime(), now.getTime());
    assert.equal(
      u.text,
      "Asha K has been admitted to General Ward A (Ward A • Bed 4, floor 1). Visiting hours: 4 PM to 7 PM. The doctor will explain the plan of care. – St. Mary's Hospital"
    );
    assert.equal(u.toLabel, 'Self');
    assert.equal(String(u.case), caseId);
    await svc.fromMessage(String(msg!._id));
    await Promise.all([svc.fromMessage(String(msg!._id)), svc.fromMessage(String(msg!._id))]);
    assert.equal(await m.PatientUpdate.countDocuments(), 1);
    assert.equal(calls.length, 0, 'making an update never sends');
    // A sample occupant gets none.
    await m.Admission.updateOne({ _id: admission._id }, { $set: { sample: true } });
    await m.PatientUpdate.deleteMany({});
    await svc.fromMessage(String(msg!._id));
    assert.equal(await m.PatientUpdate.countDocuments(), 0);
  });

  test('procedure-booked twice at the same time is one update; a new start time is a second', async () => {
    const b = await booking();
    const first = await bookedMessage(b);
    await svc.fromMessage(String(first!._id));
    let all = await updates();
    assert.equal(all.length, 1);
    assert.match(all[0].text, /^Asha K's .+ is booked for Monday, 28 September at 08:30 AM\. Please do not eat for 6 hours before/);
    assert.equal(all[0].note, undefined);
    // The booking moves: a new message, and the new start makes exactly one new update.
    await m.ProcedureBooking.updateOne({ _id: b._id }, { $set: { start: at(9, 0, 28) } });
    const second = await bookedMessage({ ...b, start: at(9, 0, 28) });
    await svc.fromMessage(String(second!._id));
    await svc.fromMessage(String(second!._id));
    all = await updates();
    assert.equal(all.length, 2);
    assert.match(all[1].dedupeKey, /^procedure-booked:.+:/);
    assert.notEqual(all[0].dedupeKey, all[1].dedupeKey);
    // A booking no longer booked makes nothing.
    await m.ProcedureBooking.updateOne({ _id: b._id }, { $set: { status: 'cancelled' } });
    const third = await bookedMessage({ ...b, start: at(11, 0, 28) });
    await svc.fromMessage(String(third!._id));
    assert.equal(await m.PatientUpdate.countDocuments(), 2);
  });

  test('estimate-ready on two ranges is one update', async () => {
    const bill = await raw(m.Bill, {
      number: 'BL-0001',
      patient: patient._id,
      patientUhid: 'MHK1',
      patientName: 'Asha K',
      kind: 'er',
      state: 'open',
      totals: { balance: 0 }
    });
    const payload = (low: number, high: number) => ({ billId: String(bill._id), billNumber: 'BL-0001', low, high });
    await send('revenue', 'revenue.estimate-ready', payload(1000, 2000));
    await send('revenue', 'revenue.estimate-ready', payload(1500, 2500));
    const u = await one();
    assert.equal(u.dedupeKey, `estimate-ready:${bill._id}`);
    assert.equal(u.text, "An estimate for Asha K's treatment is ready. Please meet the billing desk, who will explain it. – St. Mary's Hospital");
    assert.ok(!/\d{4}/.test(u.text.replace(/St\. Mary/, '')), 'no amounts in the estimate text');
  });

  test('bill-final names only the balance due, never a refund as a negative', async () => {
    const bill = await raw(m.Bill, {
      number: 'BL-0002',
      patient: patient._id,
      patientUhid: 'MHK1',
      patientName: 'Asha K',
      kind: 'er',
      state: 'final',
      totals: { balance: 0 }
    });
    await send('revenue', 'revenue.bill-final', { billId: String(bill._id), billNumber: 'BL-0002', balance: 12340 });
    assert.match((await one()).text, /Balance due: ₹12,340\./);
    await m.PatientUpdate.deleteMany({});
    await send('revenue', 'revenue.bill-final', { billId: String(bill._id), billNumber: 'BL-0002', balance: -500 });
    assert.match((await one()).text, /Balance due: ₹0\./);
  });

  test('a procedure with no approved prep text is sent without instructions and notes it', async () => {
    const b = await booking({ procedure: 'echocardiogram' });
    await bookedMessage(b);
    const u = await one();
    const name = procedureByKey('echocardiogram')!.name;
    assert.equal(u.status, 'waiting');
    assert.equal(u.note, `No approved instructions for ${name}`);
    assert.equal(u.text, `Asha K's ${name} is booked for Monday, 28 September at 08:30 AM. – St. Mary's Hospital`);
    // An unapproved prep text counts as none.
    await m.PatientUpdate.deleteMany({});
    await m.SupportTemplate.updateOne({ key: 'prep:coronary-angiography' }, { $set: { approved: false } });
    const b2 = await booking({ number: 'PR-0002', start: at(14, 0, 28) });
    await bookedMessage(b2);
    const u2 = await one();
    assert.match(u2.note, /^No approved instructions for /);
    assert.ok(!u2.text.includes('do not eat'));
  });

  test('no consent at send time: skipped no-consent, nothing sent, no timeline line', async () => {
    await consent(false);
    await assigned();
    assert.equal((await one()).status, 'waiting', 'consent is read at send time, not when it is made');
    assert.equal(await svc.sendDue(now), 1);
    const u = await one();
    assert.equal([u.status, u.reason].join('/'), 'skipped/no-consent');
    assert.equal(calls.length, 0);
    assert.equal(await m.TimelineEvent.countDocuments({ uhid: 'MHK1' }), 0);
    const skipped = await supportMessages('support.update-skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].summary, 'MHK1: Admitted update skipped (no-consent)');
    assert.equal(await svc.sendDue(now), 0);
    assert.equal((await supportMessages('support.update-skipped')).length, 1, 'announced once');
  });

  test('consent withdrawn while waiting for 07:00: skipped at send time', async () => {
    now = at(22, 30);
    await assigned();
    const waiting = await one();
    assert.equal(waiting.sendAt.getTime(), at(7, 0, 27).getTime());
    assert.equal(await svc.sendDue(at(22, 35)), 0, 'still quiet');
    assert.equal((await one()).status, 'waiting');
    await consent(false);
    assert.equal(await svc.sendDue(at(7, 0, 27)), 1);
    const u = await one();
    assert.equal([u.status, u.reason].join('/'), 'skipped/no-consent');
    assert.equal(calls.length, 0);
  });

  test('a death skips waiting updates (deceased)', async () => {
    await assigned();
    await m.Patient.updateOne({ _id: patient._id }, { $set: { status: 'Deceased' } });
    assert.equal(await svc.sendDue(now), 1);
    const u = await one();
    assert.equal([u.status, u.reason].join('/'), 'skipped/deceased');
    assert.equal(calls.length, 0);
    assert.equal((await supportMessages('support.update-skipped')).length, 1);
    // cancelForDeath stops waiting and held updates directly.
    await m.PatientUpdate.deleteMany({});
    await assigned().catch(() => null);
    const b = await booking();
    await svc.fromMessage(String((await bookedMessage(b))!._id));
    await m.PatientUpdate.updateOne({ trigger: 'procedure-booked' }, { $set: { status: 'held', reason: 'auto-off' } });
    assert.equal(await svc.cancelForDeath(String(patient._id)), 1);
    assert.equal(await svc.cancelForDeath(String(patient._id)), 0);
    assert.equal((await m.PatientUpdate.findOne({ trigger: 'procedure-booked' }).lean())!.reason, 'deceased');
  });

  test('doNotCall: skipped do-not-contact', async () => {
    await m.Patient.updateOne({ _id: patient._id }, { $set: { doNotCall: true } });
    await assigned();
    await svc.sendDue(now);
    const u = await one();
    assert.equal([u.status, u.reason].join('/'), 'skipped/do-not-contact');
    assert.equal(calls.length, 0);
  });

  test('no usable phone: skipped no-phone', async () => {
    await m.Patient.updateOne({ _id: patient._id }, { $set: { phone: '12345' } });
    await assigned();
    await svc.sendDue(now);
    assert.equal((await one()).reason, 'no-phone');
  });

  test('22:30: waiting until 07:00; an admitted update older than 12 h at 07:00 is skipped stale', async () => {
    now = at(22, 30);
    await assigned();
    assert.equal(await svc.sendDue(now), 0);
    await m.PatientUpdate.collection.updateOne({}, { $set: { createdAt: at(17, 30) } });
    assert.equal(await svc.sendDue(at(7, 0, 27)), 1);
    const u = await one();
    assert.equal([u.status, u.reason].join('/'), 'skipped/stale');
    assert.equal(calls.length, 0);
  });

  test('an admitted update made at 22:30 is sent at 07:00 when it is under 12 h old', async () => {
    now = at(22, 30);
    await assigned();
    assert.equal(await svc.sendDue(at(7, 0, 27)), 1);
    assert.equal((await one()).status, 'sample');
  });

  test('a missing ward name holds the update (missing-detail)', async () => {
    await m.Ward.updateOne({ _id: ward._id }, { $set: { name: '' } });
    await assigned();
    const u = await one();
    assert.equal([u.status, u.reason].join('/'), 'held/missing-detail');
    assert.match(u.note, /ward/);
    assert.equal(await svc.sendDue(now), 0);
    // Send now is only for the automatic switch; dismiss closes any held update.
    await assert.rejects(() => svc.sendNow(DESK, String(u._id)), ConflictException);
    const dismissed = await svc.dismiss(DESK, String(u._id));
    assert.equal([dismissed.status, dismissed.reason].join('/'), 'skipped/dismissed');
    await assert.rejects(() => svc.dismiss(DESK, String(u._id)), ConflictException);
    assert.equal((await supportMessages('support.update-skipped')).length, 1);
  });

  test('a missing template holds the update (no-template)', async () => {
    await m.SupportTemplate.updateOne({ key: 'admitted' }, { $set: { approved: false } });
    await assigned();
    assert.equal([(await one()).status, (await one()).reason].join('/'), 'held/no-template');
  });

  test('a trigger switched off is skipped at once and announced', async () => {
    await new SupportSettingsService(settings).save(ADMIN, { triggers: { admitted: false } as any });
    await assigned();
    const u = await one();
    assert.equal([u.status, u.reason].join('/'), 'skipped/trigger-off');
    assert.equal((await supportMessages('support.update-skipped')).length, 1);
  });

  test('the auto switch off holds it; Send now by the desk sends it; a nurse cannot', async () => {
    await rules.set(ADMIN, 'support-auto-updates', false);
    await assigned();
    const u = await one();
    assert.equal([u.status, u.reason].join('/'), 'held/auto-off');
    assert.equal(await svc.sendDue(now), 0);
    await assert.rejects(() => svc.sendNow(NURSE, String(u._id)), ForbiddenException);
    await assert.rejects(() => svc.dismiss(NURSE, String(u._id)), ForbiddenException);
    const view = await svc.sendNow(DESK, String(u._id));
    assert.equal(view.status, 'waiting');
    assert.equal(view.reason, null);
    assert.equal(await svc.sendDue(now), 1);
    assert.equal((await one()).status, 'sample');
    assert.equal(calls.length, 1);
    await assert.rejects(() => svc.sendNow(DESK, String(u._id)), ConflictException);
  });

  test('MESSAGE_PROVIDER none: skipped messaging-off', async () => {
    await assigned();
    const none = build(null);
    assert.equal(await none.sendDue(now), 1);
    const u = await one();
    assert.equal([u.status, u.reason].join('/'), 'skipped/messaging-off');
    assert.equal(await m.TimelineEvent.countDocuments({ uhid: 'MHK1' }), 0);
  });

  test('sample: status sample, one timeline line, one update-sent message with no name in the summary', async () => {
    await assigned();
    assert.equal(await svc.sendDue(now), 1);
    assert.equal(await svc.sendDue(now), 0);
    const u = await one();
    assert.equal(u.status, 'sample');
    assert.equal(u.to, '+919876543210');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '+919876543210');
    const lines = await m.TimelineEvent.find({ uhid: 'MHK1' }).lean();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].category, 'Communication');
    assert.equal(lines[0].title, 'Update (sample, not sent): Admitted');
    assert.equal(lines[0].subtitle, u.text);
    const sent = await supportMessages('support.update-sent');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].summary, 'MHK1: Admitted update (Sample)');
    assert.ok(!sent[0].summary.includes('Asha'));
    assert.deepEqual(sent[0].payload, { updateId: String(u._id), trigger: 'admitted', mode: 'sample' });
    // The list masks the number for everyone but an admin.
    assert.equal((await svc.list({}, NURSE))[0].to, '+91•••••43210');
    assert.equal((await svc.list({}, ADMIN))[0].to, '+919876543210');
    assert.equal((await svc.list({ status: 'held' }, ADMIN)).length, 0);
    assert.equal((await svc.list({ patientId: String(patient._id), trigger: 'admitted' }, ADMIN)).length, 1);
  });

  test('a real send is sent, with the recipient on the timeline line; a failed one is failed and not announced', async () => {
    await m.Patient.updateOne({ _id: patient._id }, { $set: { contacts: [{ _id: oid(), name: 'Ravi', relation: 'Son', phone: '9876543211' }] } });
    const p: any = await m.Patient.findById(patient._id).lean();
    await m.Patient.updateOne({ _id: patient._id }, { $set: { updatesTo: String(p.contacts[0]._id) } });
    const real = build({ name: 'real', send: async (to, text) => (calls.push([to, text]), { ok: true }) } as any);
    await assigned();
    assert.equal(await real.sendDue(now), 1);
    const u = await one();
    assert.equal([u.status, u.to, u.toLabel].join('/'), 'sent/+919876543211/Son (Ravi)');
    const lines = await m.TimelineEvent.find({ uhid: 'MHK1' }).lean();
    assert.equal(lines[0].title, 'Update sent to Son (Ravi): Admitted');
    assert.equal((await supportMessages('support.update-sent'))[0].summary, 'MHK1: Admitted update (Sent)');

    await m.PatientUpdate.deleteMany({});
    const failing = build({ name: 'real', send: async () => ({ ok: false }) } as any);
    await svc.fromMessage(String((await m.AgentMessage.findOne({ type: 'bed.assigned' }).lean())!._id));
    assert.equal(await failing.sendDue(now), 1);
    assert.equal((await one()).status, 'failed');
    assert.equal((await supportMessages('support.update-sent')).length, 1, 'a failure is not announced as sent');
  });

  test('discharge.completed of kind transfer makes no update; home makes the pack with the group warning signs and the follow-up', async () => {
    const plan = (n: number) =>
      raw(m.DischargePlan, {
        admission: oid(),
        patient: patient._id,
        patientUhid: 'MHK1',
        patientName: 'Asha K',
        bedLabel: bed.label,
        wardName: ward.name,
        case: caseId,
        targetDay: '2026-09-26',
        state: 'completed',
        n
      });
    const apt = await raw(m.Appointment, {
      uhid: 'MHK1',
      patientName: 'Asha K',
      date: '2026-09-30',
      time: '10:30 AM',
      doctorName: 'Dr. Rajesh Pillai',
      status: 'Scheduled'
    });
    const order = await raw(m.DischargeOrder, {
      patient: patient._id,
      kind: 'home',
      state: 'left',
      followUp: { followUpId: 'f1', status: 'booked', appointmentId: String(apt._id), date: '2026-09-30', time: '10:30 AM' }
    });
    const completed = (p: any, kind: string, orderId = '') =>
      send('discharge', 'discharge.completed', { planId: String(p._id), orderId, admissionId: String(admission._id), bedLabel: bed.label, kind, leftAt: now });
    await completed(await plan(1), 'transfer');
    await completed(await plan(2), 'died');
    assert.equal(await m.PatientUpdate.countDocuments(), 0);
    const home = await plan(3);
    await completed(home, 'home', String(order._id));
    const u = await one();
    assert.equal(u.trigger, 'discharge-pack');
    assert.equal(u.dedupeKey, `discharge-pack:${home._id}`);
    assert.match(
      u.text,
      /^Asha K has been discharged\. Your printed discharge summary lists the medicines\. Follow-up: Wednesday, 30 September at 10:30 AM with Dr\. Rajesh Pillai\./
    );
    assert.match(u.text, /Come back at once, or call 108, if you notice: chest pain or breathlessness; fever above 101°F/);
    assert.ok(!u.text.includes('Asha K,') && !/diagnos/i.test(u.text));
    // No order: the fallback line; a cardiac booking on the case picks the cardiac signs.
    await m.PatientUpdate.deleteMany({});
    await booking();
    const noFollow = await plan(4);
    await completed(noFollow, 'against-advice');
    const v = await one();
    assert.match(v.text, /Follow-up: as written on your discharge summary\./);
    assert.match(v.text, /chest pain, pressure or tightness/);
  });

  test('scheduling.followup-booked makes one update with the doctor', async () => {
    const apt = await raw(m.Appointment, {
      uhid: 'MHK1',
      patientName: 'Asha K',
      date: '2026-09-30',
      time: '10:30 AM',
      doctorName: 'Dr. Rajesh Pillai',
      status: 'Scheduled'
    });
    await send('scheduling', 'scheduling.followup-booked', {
      appointmentId: String(apt._id),
      date: '2026-09-30',
      time: '10:30 AM',
      doctor: 'Dr. Rajesh Pillai'
    });
    const u = await one();
    assert.equal(u.dedupeKey, `followup-booked:${apt._id}`);
    assert.equal(u.text, "Follow-up for Asha K is booked for Wednesday, 30 September at 10:30 AM with Dr. Rajesh Pillai. – St. Mary's Hospital");
  });

  test("the evening pass makes tomorrow's procedure and follow-up reminders once", async () => {
    await booking({ start: at(8, 30, 27), end: at(10, 0, 27) });
    await booking({ number: 'PR-0002', start: at(8, 30, 28), end: at(10, 0, 28) });
    await booking({ number: 'PR-0003', start: at(9, 0, 27), end: at(10, 0, 27), status: 'cancelled' });
    const tomorrowApt = await raw(m.Appointment, {
      uhid: 'MHK1',
      patientName: 'Asha K',
      date: '2026-09-27',
      time: '11:00 AM',
      doctorName: 'Dr. Rajesh Pillai',
      status: 'Scheduled'
    });
    const laterApt = await raw(m.Appointment, {
      uhid: 'MHK1',
      patientName: 'Asha K',
      date: '2026-09-28',
      time: '11:00 AM',
      doctorName: 'Dr. Rajesh Pillai',
      status: 'Scheduled'
    });
    const cancelledApt = await raw(m.Appointment, {
      uhid: 'MHK1',
      patientName: 'Asha K',
      date: '2026-09-27',
      time: '12:00 PM',
      doctorName: 'Dr. Rajesh Pillai',
      status: 'Canceled'
    });
    const item = (a: any, status = 'Scheduled') =>
      raw(m.FollowUpItem, {
        uhid: 'MHK1',
        patientName: 'Asha K',
        age: 40,
        gender: 'Female',
        followUpDate: '27 Sep 2026',
        followUpTime: '11:00 AM',
        followUpType: 'Follow-up',
        status,
        assignedTo: 'Dr. Rajesh Pillai',
        appointmentId: a._id
      });
    await item(tomorrowApt);
    await item(laterApt);
    await item(cancelledApt);
    assert.equal(await svc.remindDue(at(17, 59)), 0, 'not before the evening time');
    assert.equal(await svc.remindDue(at(18, 30)), 2);
    assert.equal(await svc.remindDue(at(18, 40)), 0, 'idempotent');
    const all = await updates();
    assert.deepEqual(all.map((u) => u.trigger).sort(), ['followup-reminder', 'procedure-reminder']);
    const proc = all.find((u) => u.trigger === 'procedure-reminder')!;
    assert.match(proc.text, /^Reminder: Asha K's .+ is tomorrow, Sunday, 27 September, at 08:30 AM\. Please do not eat for 6 hours before/);
    assert.match(proc.dedupeKey, /^procedure-reminder:.+:2026-09-27T/);
    const fu = all.find((u) => u.trigger === 'followup-reminder')!;
    assert.equal(fu.text, "Reminder: Asha K's follow-up is tomorrow, Sunday, 27 September, at 11:00 AM with Dr. Rajesh Pillai. – St. Mary's Hospital");
    assert.equal(fu.dedupeKey, `followup-reminder:${tomorrowApt._id}`);
    assert.equal(String(proc.case), caseId);
  });

  test('catchUp replays stored messages once', async () => {
    reg.wake.clear();
    const since = new Date(Date.now() - 60_000);
    await assigned();
    const bill = await raw(m.Bill, {
      number: 'BL-0001',
      patient: patient._id,
      patientUhid: 'MHK1',
      patientName: 'Asha K',
      kind: 'er',
      state: 'open',
      totals: { balance: 0 }
    });
    await send('revenue', 'revenue.estimate-ready', { billId: String(bill._id), billNumber: 'BL-0001', low: 1, high: 2 });
    await send('revenue', 'revenue.estimate-ready', { billId: String(bill._id), billNumber: 'BL-0001', low: 3, high: 4 });
    assert.equal(await m.PatientUpdate.countDocuments(), 0);
    assert.equal(await svc.catchUp(since), 2);
    assert.equal(await svc.catchUp(since), 0);
    assert.equal(await m.PatientUpdate.countDocuments(), 2);
    assert.equal(await svc.catchUp(new Date(Date.now() + 60_000)), 0);
  });

  test('a template un-approved while the update waits for 07:00 holds it (no-template) and sends nothing', async () => {
    now = at(22, 30);
    await assigned();
    await m.SupportTemplate.updateOne({ key: 'admitted' }, { $set: { approved: false } });
    assert.equal(await svc.sendDue(at(7, 0, 27)), 1);
    const u = await one();
    assert.equal([u.status, u.reason].join('/'), 'held/no-template');
    assert.equal(calls.length, 0);
    assert.equal((await supportMessages('support.update-sent')).length, 0);
  });

  test('a fresh text is made at send time: an edited template and a withdrawn prep text both show', async () => {
    now = at(22, 30);
    await svc.fromMessage(String((await bookedMessage(await booking()))!._id));
    await m.SupportTemplate.updateOne({ key: 'prep:coronary-angiography' }, { $set: { approved: false } });
    assert.equal(await svc.sendDue(at(7, 0, 27)), 1);
    const u = await one();
    assert.equal(u.status, 'sample');
    assert.ok(!u.text.includes('do not eat'), 'the withdrawn instructions are not sent');
    assert.match(u.note, /^No approved instructions for /);
  });

  test('a procedure update waiting for 07:00 is skipped superseded when the booking is cancelled overnight', async () => {
    now = at(22, 30);
    const b = await booking();
    await bookedMessage(b);
    await m.ProcedureBooking.updateOne({ _id: b._id }, { $set: { status: 'cancelled' } });
    assert.equal(await svc.sendDue(at(7, 0, 27)), 1);
    const u = await one();
    assert.equal([u.status, u.reason].join('/'), 'skipped/superseded');
    assert.equal(calls.length, 0);
    assert.equal((await supportMessages('support.update-skipped'))[0].summary, 'MHK1: Procedure booked update skipped (superseded)');
  });

  test("a procedure update is skipped superseded when the booking moves to a new time; the new time's own update is made once", async () => {
    now = at(22, 30);
    const b = await booking();
    await bookedMessage(b);
    await m.ProcedureBooking.updateOne({ _id: b._id }, { $set: { start: at(9, 0, 28) } });
    const moved = await bookedMessage({ ...b, start: at(9, 0, 28) });
    await svc.fromMessage(String(moved!._id));
    assert.equal(await m.PatientUpdate.countDocuments(), 2);
    assert.equal(await svc.sendDue(at(7, 0, 27)), 2);
    const all = await updates();
    assert.deepEqual(
      all.map((u: any) => [u.status, u.reason ?? ''].join('/')),
      ['skipped/superseded', 'sample/']
    );
    assert.match(all[1].text, /at 09:00 AM/);
    assert.equal(calls.length, 1);
  });

  test('a follow-up reminder is skipped superseded when the appointment is cancelled', async () => {
    const apt = await raw(m.Appointment, {
      uhid: 'MHK1',
      patientName: 'Asha K',
      date: '2026-09-27',
      time: '11:00 AM',
      doctorName: 'Dr. Rajesh Pillai',
      status: 'Scheduled'
    });
    await raw(m.FollowUpItem, {
      uhid: 'MHK1',
      patientName: 'Asha K',
      age: 40,
      gender: 'Female',
      followUpDate: '27 Sep 2026',
      followUpTime: '11:00 AM',
      followUpType: 'Follow-up',
      status: 'Scheduled',
      assignedTo: 'Dr. Rajesh Pillai',
      appointmentId: apt._id
    });
    assert.equal(await svc.remindDue(at(18, 30)), 1);
    await m.Appointment.updateOne({ _id: apt._id }, { $set: { status: 'Canceled' } });
    assert.equal(await svc.sendDue(at(18, 31)), 1);
    const u = await one();
    assert.equal([u.status, u.reason].join('/'), 'skipped/superseded');
    assert.equal(calls.length, 0);
    // Moved rather than cancelled: also superseded.
    await m.PatientUpdate.deleteMany({});
    await m.Appointment.updateOne({ _id: apt._id }, { $set: { status: 'Scheduled' } });
    await svc.remindDue(at(18, 40));
    await m.Appointment.updateOne({ _id: apt._id }, { $set: { time: '12:00 PM' } });
    await svc.sendDue(at(18, 41));
    assert.equal((await one()).reason, 'superseded');
  });

  test("a reminder held until the event's own day is skipped stale, never sent saying tomorrow (also on Send now)", async () => {
    // The clinic day moves on with the clock here, as it does live.
    delete process.env.CLINIC_DATE;
    try {
      await booking({ start: at(8, 30, 27), end: at(10, 0, 27) });
      const apt = await raw(m.Appointment, {
        uhid: 'MHK1',
        patientName: 'Asha K',
        date: '2026-09-27',
        time: '11:00 AM',
        doctorName: 'Dr. Rajesh Pillai',
        status: 'Scheduled'
      });
      await raw(m.FollowUpItem, {
        uhid: 'MHK1',
        patientName: 'Asha K',
        age: 40,
        gender: 'Female',
        followUpDate: '27 Sep 2026',
        followUpTime: '11:00 AM',
        followUpType: 'Follow-up',
        status: 'Scheduled',
        assignedTo: 'Dr. Rajesh Pillai',
        appointmentId: apt._id
      });
      const states = async () => (await updates()).map((u: any) => `${u.trigger}:${u.status}/${u.reason ?? ''}`).sort();

      // Made the evening before and sent then: both go.
      now = at(18, 30);
      assert.equal(await svc.remindDue(now), 2);
      assert.equal(await svc.sendDue(at(18, 31)), 2);
      assert.deepEqual(await states(), ['followup-reminder:sample/', 'procedure-reminder:sample/']);
      assert.equal(calls.length, 2);

      // Made at 22:00, inside quiet hours: they wait for 07:00, which is the event's day, so both are skipped as too old.
      await m.PatientUpdate.deleteMany({});
      calls.length = 0;
      now = at(22, 0);
      assert.equal(await svc.remindDue(now), 2);
      assert.deepEqual(
        (await updates()).map((u: any) => u.sendAt.getTime()),
        [at(7, 0, 27).getTime(), at(7, 0, 27).getTime()]
      );
      assert.equal(await svc.sendDue(at(7, 0, 27)), 2);
      assert.deepEqual(await states(), ['followup-reminder:skipped/stale', 'procedure-reminder:skipped/stale']);
      assert.equal(calls.length, 0, 'no "tomorrow" text on the day itself');

      // Held by the automatic switch: Send now on the event's day skips it as too old.
      await m.PatientUpdate.deleteMany({});
      await rules.set(ADMIN, 'support-auto-updates', false);
      now = at(18, 30);
      await svc.remindDue(now);
      const held: any = (await updates()).find((u: any) => u.trigger === 'procedure-reminder');
      assert.equal([held.status, held.reason].join('/'), 'held/auto-off');
      now = at(8, 0, 27);
      const view = await svc.sendNow(DESK, String(held._id));
      assert.equal([view.status, view.reason].join('/'), 'skipped/stale');
      await svc.sendDue(now);
      assert.equal(calls.length, 0);
      // The evening before, Send now still sends it.
      const other: any = (await updates()).find((u: any) => u.trigger === 'followup-reminder');
      now = at(19, 0);
      assert.equal((await svc.sendNow(DESK, String(other._id))).status, 'waiting');
      assert.equal(await svc.sendDue(now), 1);
      assert.equal(calls.length, 1);
    } finally {
      process.env.CLINIC_DATE = '2026-09-26';
    }
  });

  /** Spreads the stored messages one second apart, oldest first, so the cursor can tell them apart. */
  const spread = async () => {
    const all = await m.AgentMessage.find().sort({ _id: 1 }).lean();
    for (const [i, msg] of all.entries())
      await m.AgentMessage.collection.updateOne({ _id: msg._id }, { $set: { createdAt: new Date(Date.UTC(2026, 8, 26, 0, 0, i)) } });
  };

  test('catchUp advances past messages that make no update', async () => {
    reg.wake.clear();
    svc.catchUpBatch = 2;
    // Three sample occupants (no update, ever), then one real admission.
    await m.Admission.updateOne({ _id: admission._id }, { $set: { sample: true } });
    for (const n of [1, 2, 3])
      await send('bed', 'bed.assigned', { bedId: String(bed._id), bedLabel: `Bed ${n}`, admissionId: String(admission._id), ward: ward.name });
    const other = await m.Patient.create({
      uhid: 'MHK2',
      name: 'Ravi P',
      age: 50,
      gender: 'Male',
      phone: '9876543299',
      consent: { messages: true, calls: false }
    });
    const real = await raw(m.Admission, { patient: other._id, patientUhid: 'MHK1', patientName: 'Asha K', bed: bed._id, status: 'active', sample: false });
    await send('bed', 'bed.assigned', { bedId: String(bed._id), bedLabel: 'Bed 9', admissionId: String(real._id), ward: ward.name });
    await spread();
    const since = new Date(Date.UTC(2026, 8, 25));
    let made = 0;
    for (let pass = 0; pass < 2 && !made; pass++) made += await svc.catchUp(since);
    assert.equal(made, 1, 'the real message is reached within two passes');
    assert.equal((await one()).dedupeKey, `admitted:${real._id}`);
  });

  test('catchUp does not re-examine messages before the cursor', async () => {
    reg.wake.clear();
    await assigned();
    await spread();
    const since = new Date(Date.UTC(2026, 8, 25));
    assert.equal(await svc.catchUp(since), 1);
    const seen: string[] = [];
    const original = svc.fromMessage.bind(svc);
    svc.fromMessage = async (id) => (seen.push(id), original(id));
    assert.equal(await svc.catchUp(since), 0);
    assert.equal(seen.length, 0, 'nothing before or at the cursor is replayed');
    // A newer message after the cursor is examined.
    await send('revenue', 'revenue.estimate-ready', { billId: String(oid()), billNumber: 'BL-1', low: 1, high: 2 });
    await m.AgentMessage.collection.updateOne({ type: 'revenue.estimate-ready' }, { $set: { createdAt: new Date(Date.UTC(2026, 8, 26, 1)) } });
    seen.length = 0;
    await svc.catchUp(since);
    assert.equal(seen.length, 1);
    assert.equal((await m.CoordinatorCounter.findOne({ key: 'support-catchup' }).lean())!.last, Date.UTC(2026, 8, 26, 1));
  });
});
