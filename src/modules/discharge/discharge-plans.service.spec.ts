import * as assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { BED_MESSAGE_TYPES } from '../beds/bed-coordinator.bridge';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { MessagesService } from '../coordinator/messages.service';
import { RulesService } from '../coordinator/rules.service';
import { PatientEvents } from '../patients/patient-events';
import { PatientsService } from '../patients/patients.service';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { DischargeRegistration } from './discharge-coordinator.registration';
import { DischargePlansService } from './discharge-plans.service';
import { DischargeSettingsService } from './discharge-settings.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const DOCTOR = { id: 'd1', name: 'Dr. Shajin', role: UserRole.DOCTOR };
const NURSE = { id: 'n1', name: 'Nurse Anjali Thomas', role: UserRole.NURSE };
const DESK = { id: 'f1', name: 'Front Desk', role: UserRole.STAFF };
const PHARMACIST = { id: 'p1', name: 'Pharmacist', role: UserRole.PHARMACIST };
const LAB = { id: 'l1', name: 'Lab', role: UserRole.LAB };
const DAY = 24 * 60 * 60_000;
const WARD_A = 'Ward A • Bed 12';
const HDU_1 = 'HDU • Bed 1';
/** A clinic-clock (local) moment in 2026; September unless a month (0-based) is given. */
const at = (day: number, h: number, min = 0, month = 8) => new Date(2026, month, day, h, min, 0, 0);
const reminderLink = (planId: unknown) => `discharge-plan:${String(planId)}:reminder`;

type Who = { patient: any; caseId: string | null };

describe('DischargePlansService', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let cases: CasesService;
  let rules: RulesService;
  let settings: DischargeSettingsService;
  let patientEvents: PatientEvents;
  let reg: DischargeRegistration;
  let plans: DischargePlansService;
  let logged: string[];
  const logger = { error: (x: string) => logged.push(x), warn: (x: string) => logged.push(x), log: () => undefined };
  let bed: any;
  let hduBed: any;
  let ravi: { patient: any; caseId: string };

  const handler = (type: string) => registry.get('discharge')!.handles!.find((h) => h.type === type)!.handler;
  const bedMessage = (type: string, caseId: string | null, payload: Record<string, unknown>) =>
    messages.send({ case: caseId, from: 'bed', to: ['coordinator'], type, priority: 'medium', summary: `${type} (spec)`, payload });
  const assigned = (admissionId: unknown, caseId: string | null, extra: Record<string, unknown> = {}) =>
    bedMessage('bed.assigned', caseId, { bedId: String(bed._id), bedLabel: WARD_A, admissionId: String(admissionId), ward: 'General ward A (men)', ...extra });
  const planned = () => m.AgentMessage.find({ type: 'discharge.planned' }).sort({ createdAt: 1, _id: 1 }).lean();
  const stored = (id: unknown) => m.DischargePlan.findById(id).lean();
  const alertOf = (planId: unknown) => m.TaskAlertItem.findOne({ link: reminderLink(planId) }).lean();

  /** A patient with an open inpatient case. */
  const patientWithCase = async (uhid: string, name: string, extra: Record<string, unknown> = {}) => {
    const patient = await m.Patient.create({ uhid, name, age: 50, gender: 'Male', phone: '9100000005', ...extra });
    const opened = await cases.openOrJoin({ patientId: String(patient._id), patientUhid: uhid, patientName: name, kind: 'ipd', priority: 'medium', openedBy: 'bed' });
    return { patient, caseId: String(opened.case._id) };
  };
  /** A stay in Ward A • Bed 12 from 26 Sep 14:37 for 3 days, on the patient's case when there is one. */
  const admit = async (who: Who, extra: Record<string, unknown> = {}) => {
    const a = await m.Admission.create({
      patient: who.patient._id, patientUhid: who.patient.uhid, patientName: who.patient.name, bed: bed._id, doctor: 'Dr. Ravi', department: 'General Surgery',
      roomClass: 'general', expectedStayDays: 3, admittedAt: at(26, 14, 37), admittedBy: 'Nurse Anjali Thomas', ...extra,
    });
    if (who.caseId) await cases.addRefs(who.caseId, { admissionId: String(a._id) });
    return a;
  };
  /** A plan as ensurePlan writes it, made directly (Ravi Kumar's by default). */
  const planRow = (extra: Record<string, unknown> = {}) =>
    m.DischargePlan.create({
      admission: new Types.ObjectId(), case: ravi.caseId, patient: ravi.patient._id, patientUhid: 'MHK202600905', patientName: 'Ravi Kumar',
      bedLabel: WARD_A, wardName: 'General ward A (men)', doctor: 'Dr. Ravi', targetDay: '2026-09-29', targetAt: at(29, 14, 37), state: 'planned', ...extra,
    });

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    messages = new MessagesService(m.AgentMessage, registry, events);
    registry.register({ key: 'bed', messageTypes: BED_MESSAGE_TYPES, status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });
    const settingsService = new SettingsService(m.HospitalSettings);
    rules = new RulesService(registry, settingsService, events);
    settings = new DischargeSettingsService(settingsService);
    cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    reg = new DischargeRegistration(registry, messages, cases, settings, m.DischargePlan, m.DischargeOrder, m.Admission);
    logged = [];
    (reg as any).logger = logger;
    reg.onModuleInit();
    patientEvents = new PatientEvents();
    plans = new DischargePlansService(reg, messages, rules, settings, m.DischargePlan, m.Admission, m.Bed, m.Ward, m.Case, m.TaskAlertItem, m.Patient, patientEvents);
    (plans as any).logger = logger;
    plans.onModuleInit();
    plans.clock = () => at(26, 9, 30);
    const wardA = await m.Ward.create({ code: 'GWA', name: 'General ward A (men)', shortName: 'Ward A', floor: 1, type: 'general', gender: 'male', ratePerDay: 800 });
    const hdu = await m.Ward.create({ code: 'HDU', name: 'HDU (step-down)', shortName: 'HDU', floor: 2, type: 'hdu', gender: 'any', ratePerDay: 4000 });
    bed = await m.Bed.create({ ward: wardA._id, label: WARD_A, number: 12, state: 'occupied' });
    hduBed = await m.Bed.create({ ward: hdu._id, label: HDU_1, number: 1, state: 'occupied' });
    ravi = await patientWithCase('MHK202600905', 'Ravi Kumar');
  });
  afterEach(() => {
    plans.onModuleDestroy();
  });

  test('bed.assigned twice makes one plan with targetDay = admittedAt + expected stay', async () => {
    const a = await admit(ravi);
    const msg = await assigned(a._id, ravi.caseId);
    // Delivered again, twice at once (a retry), then the agent's own placement message for the same stay.
    await Promise.all([handler('bed.assigned')(String(msg!._id)), handler('bed.assigned')(String(msg!._id))]);
    await assigned(a._id, ravi.caseId, { requestId: String(new Types.ObjectId()) });
    const rows = await m.DischargePlan.find().lean();
    assert.equal(rows.length, 1);
    const p = rows[0];
    assert.deepEqual(
      [String(p.admission), String(p.case), String(p.patient), p.patientUhid, p.patientName, p.bedLabel, p.wardName, p.doctor, p.state, p.targetLog, p.remindedDay],
      [String(a._id), ravi.caseId, String(ravi.patient._id), 'MHK202600905', 'Ravi Kumar', WARD_A, 'General ward A (men)', 'Dr. Ravi', 'planned', [], undefined],
    );
    // 26 Sep 14:37 + 3 × 24 h.
    assert.equal(p.targetAt.getTime(), at(26, 14, 37).getTime() + 3 * DAY);
    assert.equal(p.targetDay, '2026-09-29');
    // One discharge.planned, from the creation: on the case, naming the bed, never the patient.
    const sent = await planned();
    assert.equal(sent.length, 1);
    assert.deepEqual([String(sent[0].case), sent[0].from, sent[0].to, sent[0].summary], [ravi.caseId, 'discharge', ['coordinator'], `${WARD_A}: Discharge planned for 29 Sep 2026`]);
    assert.deepEqual(sent[0].payload, { planId: String(p._id), admissionId: String(a._id), bedLabel: WARD_A, targetDay: '2026-09-29' });
    assert.ok(p.announcedAt && p.announcedAt.getTime() >= sent[0].createdAt.getTime(), 'announcedAt is stamped once it went (real time)');

    // Two first deliveries at once for another stay: one plan and one message; the unique index decides.
    const mary = await patientWithCase('MHK202600906', 'Mary Jeni', { gender: 'Female' });
    const b = await admit(mary, { bed: hduBed._id, doctor: 'Dr. Arun', expectedStayDays: 5 });
    const [x, y] = await Promise.all([plans.ensurePlan(String(b._id), mary.caseId), plans.ensurePlan(String(b._id), mary.caseId)]);
    assert.ok(x && y && String(x._id) === String(y._id), 'both calls get the same plan');
    assert.deepEqual(
      (await m.DischargePlan.find({ admission: b._id }).lean()).map((r) => [String(r.case), r.bedLabel, r.wardName, r.doctor, r.targetDay]),
      [[mary.caseId, HDU_1, 'HDU (step-down)', 'Dr. Arun', '2026-10-01']],
    );
    assert.equal((await planned()).filter((s) => s.payload.admissionId === String(b._id)).length, 1);
    assert.deepEqual(logged, []);
  });

  test('a sample admission gets no plan', async () => {
    // A seeded sample occupant: a made-up patient id, no Patient record and no case.
    const sample = await m.Admission.create({
      patient: new Types.ObjectId(), patientUhid: 'SAMPLE-0001', patientName: 'Sample inpatient', bed: hduBed._id, roomClass: 'hdu', expectedStayDays: 2,
      admittedAt: at(25, 10), admittedBy: 'Seed', sample: true,
    });
    assert.equal(await plans.ensurePlan(String(sample._id), null), null);
    await assigned(sample._id, null);
    // Nor does a stay that has ended, or one that does not exist; a real stay beside them does.
    const ended = await admit(ravi, { status: 'discharged', dischargedAt: at(26, 18), dischargedBy: 'Nurse Anjali Thomas' });
    assert.equal(await plans.ensurePlan(String(ended._id), ravi.caseId), null);
    assert.equal(await plans.ensurePlan(String(new Types.ObjectId()), ravi.caseId), null);
    assert.equal(await plans.ensurePlan('not-an-id', null), null);
    const mary = await patientWithCase('MHK202600906', 'Mary Jeni', { gender: 'Female' });
    const real = await admit(mary);
    assert.equal(await plans.catchUp(), 1);
    assert.deepEqual((await m.DischargePlan.find().lean()).map((p) => String(p.admission)), [String(real._id)]);
    assert.deepEqual((await planned()).map((s) => s.payload.admissionId), [String(real._id)]);
    // A message that cannot be read is logged, never thrown.
    for (const t of ['bed.assigned', 'bed.transferred', 'bed.discharged']) await assert.doesNotReject(handler(t)(String(new Types.ObjectId())), t);
    assert.equal(logged.length, 3);
    assert.ok(logged.every((l) => / not found/.test(l)), logged.join(' | '));
  });

  test('setTarget logs the change, sets 11:00 and sends discharge.planned', async () => {
    const plan = await planRow();
    const moved = await plans.setTarget(DOCTOR, String(plan._id), '2026-09-28', '  Wound healing well  ');
    assert.equal(moved?.targetDay, '2026-09-28', 'the saved plan comes back');
    let row = (await stored(plan._id))!;
    assert.equal(row.targetDay, '2026-09-28');
    assert.equal(row.targetAt.getTime(), at(28, 11).getTime());
    assert.deepEqual(
      row.targetLog.map((l) => [l.from, l.to, l.by.id, l.by.name, l.at.getTime(), l.note]),
      [['2026-09-29', '2026-09-28', 'd1', 'Dr. Shajin', at(26, 9, 30).getTime(), 'Wound healing well']],
    );
    const sent = await planned();
    assert.equal(sent.length, 1);
    assert.deepEqual(
      [String(sent[0].case), sent[0].summary, sent[0].payload],
      [ravi.caseId, `${WARD_A}: Discharge target moved to 28 Sep 2026`, { planId: String(plan._id), admissionId: String(plan.admission), bedLabel: WARD_A, targetDay: '2026-09-28' }],
    );
    assert.ok(row.announcedAt, 'announced');

    // Today is allowed, with no note, and an admin can move it too.
    await plans.setTarget(ADMIN, String(plan._id), '2026-09-26');
    row = (await stored(plan._id))!;
    assert.equal(row.targetAt.getTime(), at(26, 11).getTime());
    assert.deepEqual(row.targetLog.map((l) => [l.from, l.to, l.by.name, l.note]), [
      ['2026-09-29', '2026-09-28', 'Dr. Shajin', 'Wound healing well'],
      ['2026-09-28', '2026-09-26', 'Admin', undefined],
    ]);
    // The same day again (a repeated request) changes nothing and sends nothing.
    await plans.setTarget(DOCTOR, String(plan._id), '2026-09-26', 'again');
    assert.equal((await stored(plan._id))!.targetLog.length, 2);
    assert.equal((await planned()).length, 2);

    // Refused: a day before today, an impossible or malformed day, a long note, an unknown plan, a completed plan.
    for (const day of ['2026-09-25', '2026-09-31', '2026-13-01', '28 Sep', '']) {
      await assert.rejects(() => plans.setTarget(DOCTOR, String(plan._id), day), BadRequestException, day || 'an empty day');
    }
    await assert.rejects(() => plans.setTarget(DOCTOR, String(plan._id), '2026-09-30', 'x'.repeat(301)), BadRequestException);
    await assert.rejects(() => plans.setTarget(DOCTOR, String(new Types.ObjectId()), '2026-09-30'), NotFoundException);
    await assert.rejects(() => plans.setTarget(DOCTOR, 'not-an-id', '2026-09-30'), NotFoundException);
    await m.DischargePlan.updateOne({ _id: plan._id }, { $set: { state: 'completed' } });
    await assert.rejects(() => plans.setTarget(DOCTOR, String(plan._id), '2026-09-30'), ConflictException);
    assert.equal((await stored(plan._id))!.targetDay, '2026-09-26');
    assert.equal((await planned()).length, 2);
  });

  test('a nurse cannot set the target', async () => {
    const plan = await planRow();
    for (const actor of [NURSE, DESK, PHARMACIST, LAB]) {
      await assert.rejects(() => plans.setTarget(actor, String(plan._id), '2026-09-28'), ForbiddenException, actor.role);
    }
    await assert.rejects(() => plans.setTarget(undefined as never, String(plan._id), '2026-09-28'), ForbiddenException, 'nobody signed in');
    const row = (await stored(plan._id))!;
    assert.deepEqual([row.targetDay, row.targetLog], ['2026-09-29', []]);
    assert.equal((await planned()).length, 0);
  });

  test('at 08:59 no reminder; at 09:00 one reminder; run twice still one', async () => {
    const plan = await planRow({ targetDay: '2026-09-26', targetAt: at(26, 14, 37) });
    // Not due this morning: tomorrow's, yesterday's (overdue), one already ordered, one completed.
    await planRow({ targetDay: '2026-09-27' });
    await planRow({ targetDay: '2026-09-25' });
    await planRow({ targetDay: '2026-09-26', state: 'ordered', order: new Types.ObjectId() });
    await planRow({ targetDay: '2026-09-26', state: 'completed' });
    assert.equal(await plans.remindDue(at(26, 8, 59)), 0);
    assert.equal(await m.TaskAlertItem.countDocuments(), 0);
    assert.equal(await plans.remindDue(at(26, 9)), 1);
    const alerts = await m.TaskAlertItem.find().lean();
    assert.deepEqual(alerts.map((x) => [x.link, x.title, x.subtitle, x.patientName, x.uhid, x.type, x.category, x.priority, x.status]), [[
      reminderLink(plan._id), `Discharge due today, no order yet: ${WARD_A}`, 'For Dr. Ravi · give the discharge order, or move the target date',
      'Ravi Kumar', 'MHK202600905', 'System', 'Follow-up', 'Medium', 'Pending',
    ]]);
    assert.equal((await stored(plan._id))!.remindedDay, '2026-09-26');
    assert.equal(await plans.remindDue(at(26, 9)), 0);
    assert.equal(await plans.remindDue(at(26, 16, 45)), 0);
    assert.equal(await m.TaskAlertItem.countDocuments(), 1);

    // The time is Settings → Discharge's; an admission with no doctor gets a subtitle naming nobody.
    await settings.save(ADMIN, { reminderTime: '10:30' });
    const later = await planRow({ targetDay: '2026-09-26', bedLabel: HDU_1, doctor: '' });
    assert.equal(await plans.remindDue(at(26, 10, 29)), 0);
    assert.equal(await plans.remindDue(at(26, 10, 30)), 1);
    assert.deepEqual([(await alertOf(later._id))?.title, (await alertOf(later._id))?.subtitle], [`Discharge due today, no order yet: ${HDU_1}`, 'Give the discharge order, or move the target date']);
    assert.equal(await m.TaskAlertItem.countDocuments(), 2);
  });

  test('the switch off means no reminder', async () => {
    const plan = await planRow({ targetDay: '2026-09-26' });
    await rules.set(ADMIN, 'discharge-morning-reminder', false);
    assert.equal(await plans.remindDue(at(26, 9)), 0);
    assert.equal(await m.TaskAlertItem.countDocuments(), 0);
    assert.equal((await stored(plan._id))!.remindedDay, undefined);
    // Switched on again, the next pass raises it.
    await rules.set(ADMIN, 'discharge-morning-reminder', true);
    assert.equal(await plans.remindDue(at(26, 9, 1)), 1);
    assert.equal((await alertOf(plan._id))?.status, 'Pending');
  });

  test('an order saved while the reminder is written closes it again', async () => {
    const plan = await planRow({ targetDay: '2026-09-26' });
    // The doctor's order lands just after the reminder is written, before its day is marked: its close found nothing yet.
    const alerts = new Proxy(m.TaskAlertItem, {
      get(target, prop) {
        if (prop !== 'updateOne') {
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        }
        return (filter: any, update: any, options?: any) => ({
          exec: async () => {
            const r = await target.updateOne(filter, update, options).exec();
            if (options?.upsert) await m.DischargePlan.updateOne({ _id: plan._id }, { $set: { state: 'ordered', order: new Types.ObjectId() } });
            return r;
          },
        });
      },
    });
    const racing = new DischargePlansService(reg, messages, rules, settings, m.DischargePlan, m.Admission, m.Bed, m.Ward, m.Case, alerts, m.Patient);
    (racing as any).logger = logger;
    assert.equal(await racing.remindDue(at(26, 9)), 1);
    assert.equal((await alertOf(plan._id))?.status, 'Completed', 'no reminder is left open on an ordered plan');
    assert.deepEqual(logged, []);
  });

  test('a discharge.planned that did not go leaves announcedAt unset, for the one-minute pass', async () => {
    const sent: string[] = [];
    (reg as any).send = async (type: string) => {
      sent.push(type);
      return false;
    };
    const a = await admit(ravi);
    const plan = await plans.ensurePlan(String(a._id), ravi.caseId);
    assert.deepEqual([plan?.state, plan?.announcedAt], ['planned', undefined]);
    // A target change clears the stamp of the day it replaces.
    await m.DischargePlan.updateOne({ _id: plan!._id }, { $set: { announcedAt: new Date() } });
    await plans.setTarget(DOCTOR, String(plan!._id), '2026-09-28');
    const row = (await stored(plan!._id))!;
    assert.deepEqual([row.targetDay, row.announcedAt], ['2026-09-28', undefined]);
    assert.deepEqual(sent, ['discharge.planned', 'discharge.planned']);
  });

  test('changing the target closes the reminder', async () => {
    const plan = await planRow({ targetDay: '2026-09-26' });
    assert.equal(await plans.remindDue(at(26, 9)), 1);
    // The same day is no change: the reminder stays open.
    await plans.setTarget(DOCTOR, String(plan._id), '2026-09-26');
    assert.equal((await alertOf(plan._id))?.status, 'Pending');
    await plans.setTarget(DOCTOR, String(plan._id), '2026-09-27', 'Family comes tomorrow');
    assert.equal((await alertOf(plan._id))?.status, 'Completed');
    assert.equal(await plans.remindDue(at(26, 10)), 0, 'not due today any more');
    // On the new day the same task opens again, once.
    assert.equal(await plans.remindDue(at(27, 9)), 1);
    assert.deepEqual((await m.TaskAlertItem.find().lean()).map((x) => [x.link, x.status]), [[reminderLink(plan._id), 'Pending']]);
    assert.equal(await plans.remindDue(at(27, 12)), 0);
    // Closing is safe to repeat.
    await plans.closeReminder(String(plan._id));
    await plans.closeReminder(String(plan._id));
    assert.equal((await alertOf(plan._id))?.status, 'Completed');
  });

  test('catchUp opens plans for admissions the agent missed', async () => {
    // Missed: a stay admitted on 1 Aug, long before the agent first ran, on its case; and one no case points to.
    const old = await admit(ravi, { admittedAt: at(1, 10, 0, 7), expectedStayDays: 30 });
    const mary = await patientWithCase('MHK202600906', 'Mary Jeni', { gender: 'Female' });
    const loose = await admit({ patient: mary.patient, caseId: null }, { bed: hduBed._id });
    // Not missed: a stay that has its plan, an ended stay and a sample.
    const john = await patientWithCase('MHK202600907', 'John Peter');
    const kept = await admit(john);
    await plans.ensurePlan(String(kept._id), john.caseId);
    await admit({ patient: john.patient, caseId: null }, { status: 'discharged', admittedAt: at(1, 9, 0, 7), dischargedAt: at(5, 9, 0, 7), dischargedBy: 'Nurse Anjali Thomas' });
    await m.Admission.create({
      patient: new Types.ObjectId(), patientUhid: 'SAMPLE-0001', patientName: 'Sample inpatient', bed: hduBed._id, roomClass: 'hdu', expectedStayDays: 2,
      admittedAt: at(25, 10), admittedBy: 'Seed', sample: true,
    });
    const before = (await planned()).length;

    assert.equal(await plans.catchUp(), 2);
    const opened = await m.DischargePlan.find({ admission: { $in: [old._id, loose._id] } }).sort({ targetDay: 1 }).lean();
    // 1 Aug 10:00 + 30 days is already past: planned all the same (it shows as overdue).
    assert.deepEqual(opened.map((p) => [String(p.admission), p.case ? String(p.case) : null, p.bedLabel, p.targetDay, p.state]), [
      [String(old._id), ravi.caseId, WARD_A, '2026-08-31', 'planned'],
      [String(loose._id), null, HDU_1, '2026-09-29', 'planned'],
    ]);
    const sent = (await planned()).slice(before).map((s) => [s.payload.admissionId, s.case ? String(s.case) : null]);
    assert.deepEqual(sent.sort(), [[String(old._id), ravi.caseId], [String(loose._id), null]].sort());
    // Nothing is left: a second pass opens none and sends nothing.
    assert.equal(await plans.catchUp(), 0);
    assert.equal(await m.DischargePlan.countDocuments(), 3);
    assert.equal((await planned()).length, before + 2);
    assert.deepEqual(logged, []);
  });

  test('bed.transferred moves the plan, and an open reminder, to the new bed', async () => {
    const a = await admit(ravi, { admittedAt: at(23, 14, 37) });
    const plan = await planRow({ admission: a._id, targetDay: '2026-09-26' });
    await plans.remindDue(at(26, 9));
    // Moved to HDU • Bed 1, as BedsService.transfer records it.
    await m.Admission.updateOne({ _id: a._id }, { $set: { bed: hduBed._id }, $push: { transfers: { fromBed: bed._id, toBed: hduBed._id, at: at(26, 10), by: 'Nurse Anjali Thomas' } } });
    await bedMessage('bed.transferred', ravi.caseId, { bedId: String(hduBed._id), bedLabel: HDU_1, fromBedLabel: WARD_A, admissionId: String(a._id), ward: 'HDU (step-down)' });
    let row = (await stored(plan._id))!;
    assert.deepEqual([row.bedLabel, row.wardName, row.targetDay, row.targetLog], [HDU_1, 'HDU (step-down)', '2026-09-26', []]);
    assert.equal((await alertOf(plan._id))?.title, `Discharge due today, no order yet: ${HDU_1}`);
    // A message with no admission id finds it through the case; a closed reminder keeps its title.
    await plans.closeReminder(String(plan._id));
    await m.Admission.updateOne({ _id: a._id }, { $set: { bed: bed._id } });
    await bedMessage('bed.transferred', ravi.caseId, { bedId: String(bed._id), bedLabel: WARD_A, fromBedLabel: HDU_1, admissionId: '', ward: 'General ward A (men)' });
    row = (await stored(plan._id))!;
    assert.deepEqual([row.bedLabel, row.wardName], [WARD_A, 'General ward A (men)']);
    assert.equal((await alertOf(plan._id))?.title, `Discharge due today, no order yet: ${HDU_1}`);
    assert.deepEqual(logged, []);
  });

  test('a patient named after admission shows the new name and UHID on the plan (R15)', async () => {
    const patients = new PatientsService(m.Patient, patientEvents);
    const unknown = await patientWithCase('MHK202600990', 'Unknown male, ER-0012', { phone: '', detailsPending: true });
    const a = await admit(unknown, { bed: hduBed._id });
    const plan = await planRow({ admission: a._id, case: unknown.caseId, patient: unknown.patient._id, patientUhid: 'MHK202600990', patientName: 'Unknown male, ER-0012' });
    const other = await planRow(); // Ravi Kumar's plan is left alone.
    await patients.update(String(unknown.patient._id), { name: 'Arjun Mehta', uhid: 'MHK202600991', phone: '9100000090' });
    // The patients API does not wait for its listeners.
    for (let i = 0; i < 100 && (await stored(plan._id))!.patientName !== 'Arjun Mehta'; i++) await new Promise((r) => setTimeout(r, 20));
    const renamed = (await stored(plan._id))!;
    assert.deepEqual([renamed.patientName, renamed.patientUhid], ['Arjun Mehta', 'MHK202600991']);
    const untouched = (await stored(other._id))!;
    assert.deepEqual([untouched.patientName, untouched.patientUhid], ['Ravi Kumar', 'MHK202600905']);

    // A stay planned after the name changed takes the record's name, not the admission's old copy.
    const second = await patientWithCase('MHK202600992', 'Unknown female, ER-0013', { gender: 'Female', phone: '', detailsPending: true });
    const b = await admit(second);
    await patients.update(String(second.patient._id), { name: 'Lakshmi Devi', phone: '9100000091' });
    const fresh = await plans.ensurePlan(String(b._id), second.caseId);
    assert.deepEqual([fresh?.patientName, fresh?.patientUhid], ['Lakshmi Devi', 'MHK202600992']);
    assert.deepEqual(logged, []);
  });

  test('bed.discharged completes a planned plan whose admission was discharged outside the agent (R23)', async () => {
    const a = await admit(ravi, { admittedAt: at(23, 14, 37) });
    const plan = await planRow({ admission: a._id, targetDay: '2026-09-26' });
    await plans.remindDue(at(26, 9));
    // The bed route of an older API ends the stay, with no order.
    await m.Admission.updateOne({ _id: a._id }, { $set: { status: 'discharged', dischargedAt: at(26, 10, 15), dischargedBy: 'Nurse Anjali Thomas' } });
    await m.Patient.updateOne({ _id: ravi.patient._id }, { $set: { status: 'Discharged' } });
    const msg = await bedMessage('bed.discharged', ravi.caseId, { bedId: String(bed._id), bedLabel: WARD_A, admissionId: String(a._id) });
    const row = (await stored(plan._id))!;
    assert.deepEqual([row.state, row.completedAt?.getTime(), row.completedKind], ['completed', at(26, 10, 15).getTime(), undefined]);
    assert.equal((await alertOf(plan._id))?.status, 'Completed', 'its reminder closes');
    assert.equal(logged.length, 1);
    assert.match(logged[0], /outside the Discharge Agent/);
    assert.doesNotMatch(logged[0], /Ravi|Kumar/);
    // Delivered again: nothing more.
    await handler('bed.discharged')(String(msg!._id));
    assert.equal(logged.length, 1);
    assert.equal((await stored(plan._id))!.state, 'completed');
  });

  test('bed.discharged leaves an ordered plan, a Left without discharge and a sample to the Discharge Agent', async () => {
    // An order in progress ends its stay and then completes its plan with the kind: the bed message can come first.
    const a = await admit(ravi, { admittedAt: at(23, 14, 37) });
    const ordered = await planRow({ admission: a._id, state: 'ordered', order: new Types.ObjectId() });
    await m.Admission.updateOne({ _id: a._id }, { $set: { status: 'discharged', dischargedAt: at(26, 11) } });
    const first = await bedMessage('bed.discharged', ravi.caseId, { bedId: String(bed._id), bedLabel: WARD_A, admissionId: String(a._id) });
    // Left without discharge with no order: the patient is marked so before the bed message goes.
    const mary = await patientWithCase('MHK202600906', 'Mary Jeni', { gender: 'Female' });
    const b = await admit(mary, { bed: hduBed._id, admittedAt: at(24, 8) });
    const left = await planRow({ admission: b._id, case: mary.caseId, patient: mary.patient._id, patientUhid: 'MHK202600906', patientName: 'Mary Jeni', bedLabel: HDU_1 });
    await m.Admission.updateOne({ _id: b._id }, { $set: { status: 'discharged', dischargedAt: at(26, 7) } });
    await m.Patient.updateOne({ _id: mary.patient._id }, { $set: { status: 'Left without discharge' } });
    const second = await bedMessage('bed.discharged', mary.caseId, { bedId: String(hduBed._id), bedLabel: HDU_1, admissionId: String(b._id) });
    // A stay still active, and a sample occupant (no case, no admission id).
    const john = await patientWithCase('MHK202600907', 'John Peter');
    const c = await admit(john);
    const active = await planRow({ admission: c._id, case: john.caseId, patient: john.patient._id, patientUhid: 'MHK202600907', patientName: 'John Peter' });
    await bedMessage('bed.discharged', john.caseId, { bedId: String(bed._id), bedLabel: WARD_A, admissionId: String(c._id) });
    await bedMessage('bed.discharged', null, { bedId: String(hduBed._id), bedLabel: HDU_1 });
    assert.deepEqual([(await stored(ordered._id))!.state, (await stored(left._id))!.state, (await stored(active._id))!.state], ['ordered', 'planned', 'planned']);
    assert.deepEqual(logged, []);

    // The controls: with no order, or with the patient simply Discharged, the same messages complete the plan (R23).
    await m.DischargePlan.updateOne({ _id: ordered._id }, { $set: { state: 'planned' }, $unset: { order: 1 } });
    await handler('bed.discharged')(String(first!._id));
    await m.Patient.updateOne({ _id: mary.patient._id }, { $set: { status: 'Discharged' } });
    await handler('bed.discharged')(String(second!._id));
    assert.deepEqual([(await stored(ordered._id))!.state, (await stored(left._id))!.state], ['completed', 'completed']);
    assert.equal(logged.length, 2);
  });
});
