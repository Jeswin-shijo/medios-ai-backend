import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, mock, test } from 'node:test';
import { Logger } from '@nestjs/common';
import mongoose from 'mongoose';
import { AgentRegistry } from '../modules/coordinator/agent-registry';
import { CoordinatorEvents } from '../modules/coordinator/coordinator-events';
import { EscalationsService } from '../modules/coordinator/escalations.service';
import { MessagesService } from '../modules/coordinator/messages.service';
import { OpdService } from '../modules/opd/opd.service';
import { SUPPORT_CLOCKS } from '../modules/patient-support/support-coordinator.registration';
import { SUPPORT_START, SupportScheduler } from '../modules/patient-support/support.scheduler';
import { DEFAULT_TEMPLATES } from '../modules/patient-support/support-texts';
import { SchedulingConflictsService } from '../modules/scheduling/scheduling-conflicts.service';
import { SchedulingDoctorsService } from '../modules/scheduling/scheduling-doctors.service';
import { SchedulingRosterService } from '../modules/scheduling/scheduling-roster.service';
import { SchedulingSettingsService } from '../modules/scheduling/scheduling-settings.service';
import { SettingsService } from '../modules/settings/settings.service';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../test/test-db';
import { seedBeds } from './seed-beds';
import { seedCoordinator } from './seed-coordinator';
import { seedDischarge } from './seed-discharge';
import { seedEr } from './seed-er';
import { LAB_DEMO_ACCOUNTS, seedLab } from './seed-lab';
import { buildCounters, buildDepartments, buildDoctors } from './seed-opd';
import { seedPharmacy } from './seed-pharmacy';
import { seedRevenue } from './seed-revenue';
import { seedScheduling } from './seed-scheduling';
import { seedSupport, wire } from './seed-support';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = '2026-09-26';
/** The real clock when the seed starts: Thursday 29 Oct 2026, 10:00 local. The clinic clock is 26 Sep 2026 at the same time. */
const NOW = new Date(2026, 9, 29, 10, 0, 0, 0).getTime();
/** Each later seed runs a few seconds after the one before, as in a real run. */
const GAP = 5_000;
/** The Patient Support seed's own moment (real): after Revenue (NOW + GAP) and Discharge (NOW + 2 GAP). */
const SEED_NOW = NOW + 3 * GAP;
const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'seed-data', `${name}.json`), 'utf8'));
const SUPPORT_CLOCK_KEYS = SUPPORT_CLOCKS.map((c) => c.key);
/** The real clock, kept before the spec mocks Date. */
const RealDate = Date;

describe('seedSupport', () => {
  const m = models();
  const ids: Record<string, string> = {};
  let savedClinic: string | undefined;
  let log: string[] = [];
  /** The logins before the Patient Support seed ran. */
  let usersBefore = 0;

  /** Quiet console while seeding; returns what was logged and what was warned. */
  const quiet = async (work: () => Promise<void>): Promise<{ log: string[]; warn: string[] }> => {
    const out = { log: [] as string[], warn: [] as string[] };
    const [realLog, realWarn] = [console.log, console.warn];
    console.log = (...a: unknown[]) => {
      out.log.push(a.join(' '));
    };
    console.warn = (...a: unknown[]) => {
      out.warn.push(a.join(' '));
    };
    try {
      await work();
    } finally {
      console.log = realLog;
      console.warn = realWarn;
    }
    return out;
  };

  /** Every agent seed before Patient Support, in seed.ts's order, from `nowMs` on (Revenue and Discharge a few seconds later). */
  const theRest = async (nowMs: number) => {
    mock.timers.setTime(nowMs);
    await quiet(async () => {
      await seedBeds(DAY);
      await seedCoordinator(DAY, nowMs);
      await seedEr(DAY, nowMs);
      await seedLab(DAY, nowMs);
      await seedPharmacy(DAY, nowMs);
      await seedScheduling(DAY, nowMs);
    });
    mock.timers.setTime(nowMs + GAP);
    await quiet(() => seedRevenue(DAY, nowMs + GAP));
    delete process.env.CLINIC_DATE;
    mock.timers.setTime(nowMs + 2 * GAP);
    try {
      await quiet(() => seedDischarge(DAY, nowMs + 2 * GAP));
    } finally {
      process.env.CLINIC_DATE = DAY;
    }
  };

  /** Runs the Patient Support seed at `nowMs` without CLINIC_DATE (the seed must not depend on it). */
  const runSeed = async (seedStartedAt: number, nowMs: number): Promise<{ log: string[]; warn: string[] }> => {
    delete process.env.CLINIC_DATE;
    mock.timers.setTime(nowMs);
    try {
      return await quiet(() => seedSupport(DAY, seedStartedAt, nowMs));
    } finally {
      process.env.CLINIC_DATE = DAY;
    }
  };

  const patient = async (name: string) => (await m.Patient.findOne({ name }).lean<any>().exec())!;
  const updatesOf = async (name: string) =>
    m.PatientUpdate.find({ patient: (await patient(name))._id })
      .lean<any[]>()
      .exec();
  const checkupOf = async (name: string) =>
    (await m.CheckupCall.findOne({ patient: (await patient(name))._id })
      .lean<any>()
      .exec())!;

  before(async () => {
    await connectTestDb();
    // Mongoose's staleness check reads the real clock, but its driver stamps each heartbeat with the mocked Date: each
    // heartbeat is stamped again with the real clock, as in seed-discharge.spec.ts.
    mongoose.connection.getClient().on('serverHeartbeatSucceeded', () => {
      (mongoose.connection as unknown as { _lastHeartbeatAt: number })._lastHeartbeatAt = RealDate.now();
    });
    await resetTestDb();
    Logger.overrideLogger(false);
    savedClinic = process.env.CLINIC_DATE;
    process.env.CLINIC_DATE = DAY;
    mock.timers.enable({ apis: ['Date'], now: NOW });

    for (const [key, email, name, role, department] of [
      ['admin', 'admin@medios.ai', 'Hospital Admin', 'admin', 'Administration'],
      ['doctor', 'doctor@medios.ai', 'Dr. Shajin', 'doctor', 'General Medicine'],
      ['nurse', 'nurse@medios.ai', 'Nurse Anjali Thomas', 'nurse', 'Nursing'],
      ['pharmacist', 'pharmacy@medios.ai', 'Neethu George', 'pharmacist', 'Pharmacy'],
      ['lab', 'lab@medios.ai', 'Vishnu Prasad', 'lab', 'Laboratory'],
      ['desk', 'frontdesk@medios.ai', 'Front Desk', 'staff', 'Reception']
    ] as const)
      ids[key] = String((await m.User.create({ email, passwordHash: 'x', name, role, department }))._id);
    const path = LAB_DEMO_ACCOUNTS[0];
    await m.User.create({ email: path.email, passwordHash: 'x', name: path.name, role: path.role, department: path.department });
    const departments = buildDepartments();
    const doctors = buildDoctors(departments);
    await m.Department.insertMany(departments);
    const saved = await m.OpDoctor.insertMany(doctors.map((d) => ({ ...d, ...(d.name === 'Dr. Shajin' && { userId: ids.doctor }) })));
    const settings = fixture('settings');
    settings.queue = { ...settings.queue, counters: buildCounters(doctors) };
    settings.reception = { ...settings.reception, defaultDoctorId: String(saved.find((d: any) => d.name === 'Dr. Shajin')!._id) };
    await m.HospitalSettings.create(settings);
    await m.Patient.insertMany(fixture('patients'));
    await m.Appointment.insertMany(fixture('appointments'));
    await m.Prescription.insertMany(fixture('prescriptions'));
    await m.ClinicalDocument.insertMany(fixture('documents'));
    await m.TimelineEvent.insertMany(fixture('timeline'));
    await theRest(NOW);
    usersBefore = await m.User.countDocuments().exec();
    ({ log } = await runSeed(NOW, SEED_NOW));
  });

  after(async () => {
    mock.timers.reset();
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
    await closeTestDb();
  });

  test('Mohan Raj has a Sample angiography-booked update with instructions in Tamil and an estimate update', async () => {
    const mohan = await patient('Mohan Raj');
    // Contact and consent, recorded at the desk: Tamil, updates to his son Ravi, messages and calls.
    assert.equal(mohan.preferredLanguage, 'ta');
    assert.deepEqual(
      mohan.contacts.map((c: any) => [c.name, c.relation, c.phone]),
      [['Ravi', 'Son', '9000009300']]
    );
    assert.equal(mohan.updatesTo, String(mohan.contacts[0]._id));
    assert.deepEqual([mohan.consent.messages, mohan.consent.calls, mohan.consent.via, mohan.consent.recordedByName], [true, true, 'desk', 'Front Desk']);

    const updates = await updatesOf('Mohan Raj');
    const booking = (await m.ProcedureBooking.findOne({ patient: mohan._id, procedure: 'coronary-angiography' }).lean<any>().exec())!;
    const angio = updates.find((u) => u.trigger === 'procedure-booked' && u.dedupeKey.startsWith(`procedure-booked:${booking._id}:`))!;
    assert.ok(angio, 'an angiography-booked update');
    assert.deepEqual([angio.status, angio.language, angio.toLabel, angio.to], ['sample', 'ta', 'Son (Ravi)', '+919000009300']);
    const prepTa = DEFAULT_TEMPLATES.find((t) => t.key === 'prep:coronary-angiography')!.ta;
    assert.ok(prepTa && angio.text.includes(prepTa), `the Tamil preparation text is in: ${angio.text}`);
    assert.ok(!angio.note, 'its preparation text was found');
    assert.ok(angio.sentAt, 'sent (in sample mode)');

    const bill = (await m.Bill.findOne({ patient: mohan._id, kind: 'er' }).lean<any>().exec())!;
    const estimate = updates.find((u) => u.trigger === 'estimate-ready')!;
    assert.ok(estimate, 'an estimate update');
    assert.deepEqual([estimate.status, estimate.dedupeKey, estimate.language], ['sample', `estimate-ready:${bill._id}`, 'ta']);
    // Both went to the Coordinator, with the UHID and never the name.
    for (const u of [angio, estimate]) {
      const msg = (await m.AgentMessage.findOne({ type: 'support.update-sent', 'payload.updateId': String(u._id) })
        .lean<any>()
        .exec())!;
      assert.equal(msg.summary, `${mohan.uhid}: ${u.trigger === 'estimate-ready' ? 'Estimate ready' : 'Procedure booked'} update (Sample)`);
    }
    // Sample sends leave a Communication line on his Timeline.
    assert.ok(await m.TimelineEvent.exists({ uhid: mohan.uhid, category: 'Communication', title: 'Update (sample, not sent): Procedure booked' }).exec());
    assert.match(log.join('\n'), /✅ Patient Support/);
  });

  test("James Wilson's estimate update is held by the switch, which is back on; David Raj's follow-up went to his daughter", async () => {
    const held = (await updatesOf('James Wilson')).filter((u) => u.status === 'held');
    assert.equal(held.length, 1);
    assert.deepEqual([held[0].trigger, held[0].reason], ['estimate-ready', 'auto-off']);
    assert.equal(await m.PatientUpdate.countDocuments({ status: 'held' }).exec(), 1, 'the only held update');
    const settings = (await m.HospitalSettings.findOne().lean<any>().exec())!;
    assert.equal(settings.coordinator?.rules?.['support-auto-updates'], true, 'the switch is back on');
    const david = (await updatesOf('David Raj')).find((u) => u.trigger === 'followup-booked')!;
    assert.deepEqual([david.status, david.toLabel, david.to], ['sample', 'Daughter (Anitha)', '+919000009301']);
    // No admitted updates: no consenting patient has a bed.assigned in the seed.
    assert.equal(await m.PatientUpdate.countDocuments({ trigger: 'admitted' }).exec(), 0);
  });

  test("Senthil Kumar R's discharge pack is skipped for no consent", async () => {
    const senthil = (await updatesOf('Senthil Kumar R')).find((u) => u.trigger === 'discharge-pack')!;
    assert.ok(senthil, 'a discharge pack was made from the replayed discharge.completed');
    assert.deepEqual([senthil.status, senthil.reason], ['skipped', 'no-consent']);
    assert.equal(senthil.sentAt, undefined);
    const msg = (await m.AgentMessage.findOne({ type: 'support.update-skipped', 'payload.updateId': String(senthil._id) })
      .lean<any>()
      .exec())!;
    assert.equal(msg.summary, `${(await patient('Senthil Kumar R')).uhid}: Discharge pack update skipped (no-consent)`);
    // The two Home stays that left today agreed: their packs went (in sample mode), with the warning signs.
    for (const name of ['Meenakshi T', 'Babu Thomas']) {
      const pack = (await updatesOf(name)).find((u) => u.trigger === 'discharge-pack')!;
      assert.deepEqual([pack?.status, pack?.toLabel], ['sample', 'Self'], name);
      assert.match(pack.text, /Come back at once, or call 108, if you notice: /);
    }
    // Every update of a patient with no consent was skipped, never sent.
    const consenting = (await m.Patient.find({ 'consent.messages': true }).select('_id').lean<any[]>().exec()).map((p) => String(p._id));
    assert.equal(consenting.length, 9);
    const others = await m.PatientUpdate.find({ patient: { $nin: consenting } })
      .lean<any[]>()
      .exec();
    assert.ok(others.length >= 10, `${others.length} updates for patients with no consent`);
    for (const u of others)
      assert.deepEqual([u.status, u.reason], ['skipped', u.reason === 'superseded' ? 'superseded' : 'no-consent'], `${u.trigger} ${u.patientUhid}`);
    assert.equal(await m.PatientUpdate.countDocuments({ status: { $in: ['sent', 'failed'] } }).exec(), 0, 'sample mode sends nothing for real');
  });

  test('there are tickets in every shown status, two escalated with real escalations', async () => {
    const w = wire();
    const rows = await w.tickets.list();
    assert.ok(rows.length >= 14 && rows.length <= 16, `${rows.length} tickets`);
    assert.deepEqual([...new Set(rows.map((r) => r.shown))].sort(), ['Escalated', 'In progress', 'Open', 'Resolved', 'Waiting on caller']);
    assert.deepEqual([...new Set(rows.map((r) => r.ticketType))].sort(), [
      'admission',
      'appointment',
      'billing',
      'clinical',
      'complaint',
      'directions',
      'discharge',
      'medicines',
      'other',
      'reports'
    ]);
    assert.deepEqual([...new Set(rows.map((r) => r.channel))].sort(), ['desk', 'phone']);
    assert.deepEqual([...new Set(rows.map((r) => r.source))].sort(), ['call-back', 'call-unanswered', 'desk', 'emergency-call', 'feedback']);
    assert.ok(
      rows.some((r) => r.onTheSpot && r.state === 'resolved'),
      'answered on the spot'
    );
    assert.ok(rows.filter((r) => r.state === 'resolved' && !r.onTheSpot).length >= 3, 'three resolved');

    // The urgent call-back through the bridge: billing, with the number to ring back and its urgent alert.
    const callBack = rows.find((r) => r.source === 'call-back')!;
    assert.deepEqual([callBack.ticketType, callBack.priority, callBack.owner, callBack.channel], ['billing', 'urgent', 'billing', 'phone']);
    assert.match(callBack.callerPhone, /^\+91\d{10}$/);
    assert.ok(callBack.providerCallId);
    const urgent = (await m.TaskAlertItem.findOne({ link: `support-ticket:${callBack.id}:urgent` })
      .lean<any>()
      .exec())!;
    assert.deepEqual(
      [urgent.status, urgent.category, urgent.title],
      ['Pending', 'Critical', `Urgent ticket ${callBack.number} for Billing in charge: Billing`]
    );
    // Handed on from the desk to billing: round 2, on the billing ladder.
    const handed = rows.find((r) => r.round === 2)!;
    assert.deepEqual([handed.ticketType, handed.owner, handed.ladder, handed.shown], ['billing', 'billing', 'support-billing', 'Open']);
    const detail = await w.tickets.detail(handed.id);
    assert.ok(detail.notes.some((n) => n.kind === 'hand-on' && /Handed on to Billing in charge/.test(n.text)));
    assert.equal(await m.Clock.countDocuments({ def: 'support-response', ref: `${handed.id}:1`, state: 'met' }).exec(), 1, 'the desk round closed');
    assert.equal(await m.Clock.countDocuments({ def: 'support-response-billing', ref: `${handed.id}:2`, state: 'running' }).exec(), 1);
    // The complaint from the 2-star rating, for the Patient relations officer.
    const complaint = rows.find((r) => r.source === 'feedback')!;
    assert.deepEqual(
      [complaint.ticketType, complaint.owner, complaint.question],
      ['complaint', 'relations', 'Waited over an hour at the billing desk with no update.']
    );

    // Two escalated: opened five hours back with no answer, so their clocks expired and their ladders were raised.
    const escalated = rows.filter((r) => r.shown === 'Escalated');
    assert.equal(escalated.length, 2);
    assert.deepEqual(escalated.map((r) => r.ladder).sort(), ['support-clinical', 'support-ward']);
    for (const t of escalated) {
      assert.ok(Math.abs(new Date(t.openedAt).getTime() - (SEED_NOW - 5 * HOUR)) <= 15 * MIN, `${t.number} opened about five hours back`);
      assert.ok(new Date(t.dueAt).getTime() < SEED_NOW);
      assert.equal(t.roundAnsweredAt, null);
      const clock = (await m.Clock.findOne({ ref: `${t.id}:1`, def: { $in: SUPPORT_CLOCK_KEYS } })
        .lean<any>()
        .exec())!;
      assert.equal(clock.state, 'expired');
      const esc = (await m.Escalation.findById(clock.escalation).lean<any>().exec())!;
      assert.deepEqual(
        [esc.state, esc.ladder, esc.source.kind, esc.source.id, esc.alertLink],
        ['open', t.ladder, 'clock', String(clock._id), `support-ticket:${t.id}:1`]
      );
      assert.equal(esc.reason, `First response overdue — ${t.number} (${t.typeLabel})`);
      const alert = (await m.TaskAlertItem.findOne({ link: `support-ticket:${t.id}:1` })
        .lean<any>()
        .exec())!;
      assert.equal(alert.status, 'Pending');
      assert.match(alert.title, /^Escalated to (Duty doctor|Ward nurse in charge): First response overdue/);
    }
    // Nothing else is overdue: every other unanswered round is still within its time.
    assert.equal(await m.Clock.countDocuments({ def: { $in: SUPPORT_CLOCK_KEYS }, state: 'expired' }).exec(), 2);
    for (const r of rows.filter((x) => x.state !== 'resolved' && !x.roundAnsweredAt && x.shown !== 'Escalated')) {
      assert.ok(new Date(r.dueAt).getTime() > SEED_NOW, `${r.number} is not overdue`);
    }
    assert.equal(await m.Escalation.countDocuments({ ladder: { $in: ['patient-support', 'support-billing', 'support-ward', 'support-clinical'] } }).exec(), 2);
  });

  test('the four check-up states, with an ER expected card for the Sent to ER one', async () => {
    const w = wire();
    const tab = async (t: Parameters<typeof w.checkups.list>[0]) => (await w.checkups.list(t)).map((r) => r.patientName).sort();
    assert.deepEqual(await tab('sent-to-er'), ['Gopal Krishnan']);
    assert.deepEqual(await tab('needs-doctor'), ['Rosamma Thomas']);
    assert.deepEqual(await tab('done'), ['Saravanan K']);
    assert.deepEqual(await tab('to-do'), ['Deepika S']);
    assert.deepEqual(await tab('coming-up'), ['Babu Thomas', 'Meenakshi T', 'Senthil Kumar R']);
    assert.deepEqual(await tab('not-reached'), []);

    // The four earlier patients went home two days before the clinic day, at 11:00; due today.
    for (const name of ['Gopal Krishnan', 'Rosamma Thomas', 'Saravanan K', 'Deepika S']) {
      const c = await checkupOf(name);
      assert.equal(c.sourceKey, `seed:${c.patient}`);
      assert.equal(new Date(c.leftAt).getTime(), new Date(2026, 8, 24, 11, 0, 0, 0).getTime(), name);
      assert.deepEqual([c.dueDay, c.kind], [DAY, 'home'], name);
    }
    // Gopal Krishnan: switched to the cardiac list at the desk; an emergency answer sent him to the ER with a real card.
    const gopal = await checkupOf('Gopal Krishnan');
    assert.deepEqual([gopal.group, gopal.result, gopal.emergency, gopal.byName], ['cardiac', 'sent-to-er', ['symptoms'], 'Front Desk']);
    const card = (await m.ErExpected.findOne({ patient: gopal.patient }).lean<any>().exec())!;
    assert.ok(card, 'an ER expected card');
    assert.deepEqual([card.byName, card.state, card.mode], ['Patient Support Agent', 'waiting', 'walk-in']);
    assert.equal(card.complaint, `Check-up ${gopal.number}: Chest pain, breathlessness or stroke signs`);
    const erAlert = (await m.TaskAlertItem.findOne({ link: `support-checkup:${gopal._id}:er` })
      .lean<any>()
      .exec())!;
    assert.equal(erAlert.title, `Check-up ${gopal.number} sent to the ER`);
    assert.match(erAlert.subtitle, /^Duty doctor: .+; Cardiology on call: /);
    // Rosamma Thomas: switched to the cardiac list; not taking both blood thinners, so a doctor must review, on a clock.
    const rosamma = await checkupOf('Rosamma Thomas');
    assert.deepEqual([rosamma.group, rosamma.result, rosamma.worrying], ['cardiac', 'needs-doctor', ['antiplatelets']]);
    const clock = (await m.Clock.findOne({ def: 'support-checkup-doctor', ref: String(rosamma._id) })
      .lean<any>()
      .exec())!;
    assert.equal(clock.state, 'running');
    assert.ok(clock.dueAt.getTime() > SEED_NOW);
    assert.equal(
      (await m.TaskAlertItem.findOne({ link: `support-checkup:${rosamma._id}:doctor` })
        .lean<any>()
        .exec())!.status,
      'Pending'
    );
    // Saravanan K: fine, rated 5 on the call.
    const saravanan = await checkupOf('Saravanan K');
    assert.deepEqual([saravanan.result, saravanan.rating], ['fine', 5]);
    assert.ok(await m.SupportFeedback.exists({ checkup: saravanan._id, source: 'call', overall: 5 }).exec());
    // The three who left today: from the replayed discharge.completed, two days after leaving.
    for (const name of ['Meenakshi T', 'Babu Thomas', 'Senthil Kumar R']) {
      const c = await checkupOf(name);
      assert.match(c.sourceKey, /^discharge:/);
      assert.deepEqual([c.state, c.dueDay], ['scheduled', '2026-09-28'], name);
    }
  });

  test('about ten ratings over seven days, and the 2-star one is the complaint', async () => {
    const all = await m.SupportFeedback.find().lean<any[]>().exec();
    assert.ok(all.length >= 9 && all.length <= 12, `${all.length} ratings`);
    const at = all.map((f) => new Date(f.at).getTime());
    assert.ok(Math.min(...at) >= SEED_NOW - 7 * 24 * HOUR && Math.max(...at) <= SEED_NOW, 'within the last seven days');
    assert.ok(Math.min(...at) <= SEED_NOW - 5 * 24 * HOUR, 'spread over the week');
    assert.ok(
      all.some((f) => f.source === 'desk' && Object.keys(f.aspects ?? {}).length > 0),
      'desk ratings with aspects'
    );
    assert.ok(all.filter((f) => f.source === 'call').length >= 2, 'call ratings from the check-ups');
    const poor = all.filter((f) => f.overall <= 2);
    assert.equal(poor.length, 1);
    assert.deepEqual(
      [poor[0].source, poor[0].overall, poor[0].comment, poor[0].complaint],
      ['desk', 2, 'Waited over an hour at the billing desk with no update.', true]
    );
    const ticket = (await m.SupportTicket.findById(poor[0].ticket).lean<any>().exec())!;
    assert.deepEqual([ticket.ticketType, ticket.owner, ticket.source, String(ticket.feedback)], ['complaint', 'relations', 'feedback', String(poor[0]._id)]);
    assert.ok(await m.AgentMessage.exists({ type: 'support.complaint', 'payload.feedbackId': String(poor[0]._id) }).exec());
  });

  test('patient-relations is held by the front desk and seed-scheduling still has exactly its two conflicts', async () => {
    const title = (await m.DutyTitle.findOne({ key: 'patient-relations' }).lean<any>().exec())!;
    assert.deepEqual(title.holders.map(String), [ids.desk]);
    // No new logins.
    assert.equal(await m.User.countDocuments().exec(), usersBefore);
    const registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    const messages = new MessagesService(m.AgentMessage, registry, events);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    const settingsService = new SettingsService(m.HospitalSettings);
    const roster = new SchedulingRosterService(m.StaffMember, m.RosterEntry, new SchedulingSettingsService(settingsService), escalations);
    roster.onModuleInit();
    const doctors = new SchedulingDoctorsService(m.DoctorProfile, m.Appointment, new OpdService(m.Department, m.OpDoctor, settingsService));
    const conflicts = new SchedulingConflictsService(
      m.Appointment,
      m.ProcedureBooking,
      m.RoomBlock,
      m.OpDoctor,
      m.StaffMember,
      m.WaitItem,
      m.TaskAlertItem,
      doctors,
      roster,
      escalations
    );
    const found = await conflicts.sweep();
    assert.deepEqual(found.map((c: any) => c.kind).sort(), ['room-blocked', 'running-late']);
    const open = await m.TaskAlertItem.find({ link: /^scheduling-conflict:/, status: { $ne: 'Completed' } })
      .lean<any[]>()
      .exec();
    assert.deepEqual(open.map((c) => c.link.split(':')[1]).sort(), ['room-blocked', 'running-late']);
  });

  test('no Patient Support message summary names a patient', async () => {
    const names = (await m.Patient.find().select('name').lean<any[]>().exec()).map((p) => p.name as string).filter((n) => n && n.length >= 4);
    const phones = (await m.Patient.find({ 'consent.messages': true }).select('phone contacts').lean<any[]>().exec()).flatMap((p) =>
      [p.phone, ...(p.contacts ?? []).map((c: any) => c.phone)]
        .map((x) =>
          String(x ?? '')
            .replace(/\D/g, '')
            .slice(-10)
        )
        .filter((x) => x.length === 10)
    );
    assert.ok(phones.length >= 11, `${phones.length} phones`);
    const hay = (text: string) => text.toLowerCase();
    const clean = (text: string, what: string) => {
      for (const n of names) assert.ok(!hay(text).includes(n.toLowerCase()), `${what} names ${n}: ${text}`);
      for (const ph of phones) assert.ok(!text.includes(ph), `${what} holds a phone: ${text}`);
    };
    const messages = await m.AgentMessage.find({ from: 'patient-support' }).lean<any[]>().exec();
    assert.ok(messages.length >= 40, `${messages.length} Patient Support messages`);
    const types = new Set(messages.map((x) => x.type));
    for (const t of [
      'support.update-sent',
      'support.update-skipped',
      'support.ticket-opened',
      'support.ticket-answered',
      'support.ticket-resolved',
      'support.checkup-done',
      'support.checkup-worrying',
      'support.complaint'
    ])
      assert.ok(types.has(t), t);
    for (const msg of messages) {
      clean(`${msg.summary} ${JSON.stringify(msg.payload ?? {})}`, msg.type);
      assert.ok(msg.summary.length <= 140, msg.summary);
    }
    for (const a of await m.TaskAlertItem.find({ link: /^support-/ })
      .lean<any[]>()
      .exec())
      clean(`${a.title} ${a.subtitle ?? ''}`, a.link);
    for (const c of await m.Clock.find({ def: { $in: SUPPORT_CLOCK_KEYS } })
      .lean<any[]>()
      .exec())
      clean(c.detail ?? '', c.def);
    for (const e of await m.Escalation.find({ ladder: { $in: ['patient-support', 'support-billing', 'support-ward', 'support-clinical'] } })
      .lean<any[]>()
      .exec())
      clean(e.reason, `escalation ${e.ladder}`);
    for (const card of await m.ErExpected.find({ byName: 'Patient Support Agent' }).lean<any[]>().exec()) clean(card.complaint, 'ER card');
  });

  test('support-start is stamped at the seed moment, and the first minute pass replays, sends and changes nothing', async () => {
    const start = (await m.CoordinatorCounter.findOne({ key: SUPPORT_START }).lean<any>().exec())!;
    assert.equal(start.last, SEED_NOW);
    // Three minutes on: past the check-up repairs' two-minute grace, so only the seeded records' own state keeps them quiet.
    mock.timers.setTime(SEED_NOW + 3 * MIN);
    try {
      const w = wire();
      const scheduler = new SupportScheduler(w.updates, w.tickets, w.checkups, w.texts, m.CoordinatorCounter);
      const snap = async () => ({
        messages: await m.AgentMessage.countDocuments().exec(),
        updates: (await m.PatientUpdate.find().sort({ _id: 1 }).lean<any[]>().exec()).map((u) => [
          String(u._id),
          u.status,
          u.reason ?? null,
          [...u.announced].sort().join(',')
        ]),
        tickets: (await m.SupportTicket.find().sort({ _id: 1 }).lean<any[]>().exec()).map((t) => [
          String(t._id),
          t.state,
          t.round,
          [...t.announced].sort().join(','),
          !!t.escalatedAt
        ]),
        checkups: (await m.CheckupCall.find().sort({ _id: 1 }).lean<any[]>().exec()).map((c) => [
          String(c._id),
          c.state,
          c.result ?? null,
          [...c.announced].sort().join(',')
        ]),
        alerts: (
          await m.TaskAlertItem.find({ link: /^support-/ })
            .sort({ _id: 1 })
            .lean<any[]>()
            .exec()
        ).map((a) => [a.link, a.status]),
        cards: await m.ErExpected.countDocuments().exec(),
        feedback: await m.SupportFeedback.countDocuments().exec()
      });
      const before = await snap();
      await scheduler.tick();
      assert.deepEqual(await snap(), before, 'the first minute pass sent and changed nothing');
    } finally {
      mock.timers.setTime(SEED_NOW);
    }
  });

  test('running the seed twice gives the same counts', async () => {
    const counts = async () => ({
      updates: (await m.PatientUpdate.find().lean<any[]>().exec()).map((u) => `${u.patientUhid}:${u.trigger}:${u.status}:${u.reason ?? '-'}`).sort(),
      tickets: (await wire().tickets.list({ limit: 500 })).map((t) => `${t.number}:${t.ticketType}:${t.shown}:${t.round}:${t.source}`).sort(),
      checkups: (await m.CheckupCall.find().lean<any[]>().exec()).map((c) => `${c.number}:${c.patientUhid}:${c.state}:${c.result ?? '-'}:${c.group}`).sort(),
      feedback: (await m.SupportFeedback.find().lean<any[]>().exec()).map((f) => `${f.source}:${f.overall}:${f.complaint}`).sort(),
      messages: (await m.AgentMessage.find({ from: 'patient-support' }).lean<any[]>().exec()).map((x) => x.type).sort(),
      clocks: (
        await m.Clock.find({ def: { $in: SUPPORT_CLOCK_KEYS } })
          .lean<any[]>()
          .exec()
      )
        .map((c) => `${c.def}:${c.state}`)
        .sort(),
      escalations: await m.Escalation.countDocuments().exec(),
      alerts: (
        await m.TaskAlertItem.find({ link: /^support-/ })
          .lean<any[]>()
          .exec()
      )
        .map((a) => `${a.status}:${a.title.replace(/\d{4}/g, '#')}`)
        .sort(),
      cards: await m.ErExpected.countDocuments().exec(),
      allMessages: await m.AgentMessage.countDocuments().exec(),
      allClocks: await m.Clock.countDocuments().exec(),
      timeline: await m.TimelineEvent.countDocuments({ category: 'Communication' }).exec(),
      templates: await m.SupportTemplate.countDocuments().exec(),
      faqs: await m.SupportFaq.countDocuments().exec(),
      consent: await m.Patient.countDocuments({ 'consent.messages': true }).exec(),
      contacts: await m.Patient.countDocuments({ 'contacts.0': { $exists: true } }).exec(),
      counters: (
        await m.CoordinatorCounter.find({ key: { $in: ['support-ticket', 'support-checkup'] } })
          .lean<any[]>()
          .exec()
      )
        .map((c) => `${c.key}:${c.last}`)
        .sort(),
      users: await m.User.countDocuments().exec()
    });
    const first = await counts();
    // Patient Support's own rows are replaced; the other agents' records stay as they are.
    await runSeed(NOW, SEED_NOW + 2 * GAP);
    try {
      assert.deepEqual(await counts(), first);
    } finally {
      mock.timers.setTime(SEED_NOW);
    }
  });
});
