import * as assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { DOC, PHARM, World, amoxicillin500, buildWorld, pantoprazole40 } from '../../test/pharmacy-fixtures';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AiProvider } from '../ai/ai-provider';
import { AiProviderName } from '../ai/ai-types';
import { AiService } from '../ai/ai.service';
import { AppointmentEvents } from '../appointments/appointment-events';
import { BedEvents } from '../beds/bed-events';
import { BedsService } from '../beds/beds.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { RulesService } from '../coordinator/rules.service';
import { DocumentsService } from '../documents/documents.service';
import { OpdService } from '../opd/opd.service';
import { PatientsService } from '../patients/patients.service';
import { SchedulingAppointmentsService } from '../scheduling/scheduling-appointments.service';
import { SCHEDULING_MESSAGE_TYPES } from '../scheduling/scheduling-coordinator.registration';
import { SchedulingDoctorsService } from '../scheduling/scheduling-doctors.service';
import { SchedulingFollowupsService } from '../scheduling/scheduling-followups.service';
import { SchedulingWaitlistService } from '../scheduling/scheduling-waitlist.service';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { CourseFacts, DischargeAiService, leaks, templateCourse, templateDaySummary } from './discharge-ai';
import { DEFAULT_WARNING_SIGNS } from './discharge-catalogue';
import { DischargeRegistration } from './discharge-coordinator.registration';
import { DischargeLinesService } from './discharge-lines.service';
import { DischargeOrdersService, OrderInput } from './discharge-orders.service';
import { DischargePlansService } from './discharge-plans.service';
import { DischargeSettingsService } from './discharge-settings.service';
import { DischargeSummaryService, EDITABLE_SECTIONS, SUMMARY_CHANGED, summaryText } from './discharge-summary.service';
import { COURSE_SOURCES } from './schemas/discharge-summary.schema';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const NURSE = { id: 'n1', name: 'Nurse Anjali Thomas', role: UserRole.NURSE };
const DESK = { id: 'f1', name: 'Front Desk', role: UserRole.STAFF };
const LAB = { id: 'l1', name: 'Lab Technician', role: UserRole.LAB };
const MIN = 60_000;
const BED = 'GWA-12';
const WARD_NAME = 'General ward A (men)';
const NAME = 'Ravi Kumar';
const UHID = 'MHK202600901';
/** A clinic-clock (local) moment in September 2026. */
const at = (day: number, h: number, min = 0) => new Date(2026, 8, day, h, min, 0, 0);
const NOW = at(26, 11);
const REASON = 'Fever and breathlessness for three days, for IV antibiotics';
const DIAGNOSIS = 'Community-acquired pneumonia, treated';
const NOTE = 'Walks unaided; eating well';
const HOSPITAL = 'Government Medical College Hospital, Thiruvananthapuram';
const TRANSFER_WHY = 'Needs cardiothoracic surgery';
const CAUSE = 'Cardiorespiratory arrest from septic shock';
const ALL_DAY = [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '17:00' }];
const status = async () => ({ open: 0, capacity: 0, onTimePct: null });
const AI_TEXT = 'Cared for in intensive care and then on the general ward; recovered well and goes home improved.';
/** The rules' course paragraph for `theStay`: wards and days, procedures, tests with flags, medicines, condition. */
const STAY_COURSE =
  'Admitted to the ICU for 1 day, then the general ward for 2 days. Echocardiogram. Investigations: Troponin I (critical), Complete blood count (abnormal), CRP (normal). Treated with 2 medicines. Condition at discharge: improved.';
/** The same stay with no procedures, results or medicines on record. */
const BARE_COURSE = 'Admitted to the ICU for 1 day, then the general ward for 2 days. Condition at discharge: improved.';
const STAY_FACTS: CourseFacts = {
  kind: 'home',
  wards: [{ type: 'icu', days: 1 }, { type: 'general', days: 2 }],
  procedures: ['Echocardiogram'],
  tests: [{ name: 'Troponin I', flag: 'critical' }, { name: 'Complete blood count', flag: 'abnormal' }, { name: 'CRP', flag: 'normal' }],
  medicineCount: 2,
  condition: 'improved',
  stayDays: 3,
};
const RESULTS = [
  'Troponin I (critical), 24 Sep 2026: 0.9 ng/mL (high, critical)',
  'Complete blood count (abnormal), 25 Sep 2026: Haemoglobin 10.2 g/dL (low); WBC 7.1 ×10³/µL; Platelets 210 ×10³/µL',
  'CRP, 25 Sep 2026: 3 mg/L',
].join('\n');
const PANTOPRAZOLE = 'Pantoprazole 40 mg, oral, once a day (OD), for 7 days';
const AMOXICILLIN = 'Amoxicillin 500 mg, oral, three times a day (TDS), for 5 days';
const HOME_HEADINGS = [
  'Patient details', 'Reason for admission', 'Final diagnosis', 'Course in hospital', 'Procedures done', 'Key results', 'Condition at discharge',
  'Medicines at discharge', 'Follow-up', 'Warning signs',
];
const details = (leaving: string, name = NAME, uhid = UHID, ageSex = '62 years, Male') =>
  [
    `Name: ${name}`, `UHID: ${uhid}`, `Age and sex: ${ageSex}`, 'Date of admission: 23 Sep 2026', leaving,
    `Ward and bed: ${WARD_NAME}, ${BED}`, 'Consultant: Dr. Shajin', 'Department: General Medicine',
  ].join('\n');
const row = (param: string, value: number | string, unit: string, flag = 'normal', critical = false) => ({ param, value, unit, flag, critical });

/** A provider that records exactly what the AI client is handed. */
function stubProvider(name: AiProviderName, answer: unknown = { text: AI_TEXT }) {
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

describe('DischargeSummaryService', () => {
  const m = models();
  let w: World;
  let reg: DischargeRegistration;
  let lines: DischargeLinesService;
  let orders: DischargeOrdersService;
  let summary: DischargeSummaryService;
  let shajin: any;
  let meena: any;
  let general: any;
  let caseId: string;
  let planId: string;
  let admissionId: string;
  let logged: string[];
  let logger: { error: (x: string) => void; warn: (x: string) => void; log: () => void };
  let savedClinic: string | undefined;
  let seq: number;
  let settings: DischargeSettingsService;

  /** A summary service on this world, with its own clock (the clinic clock) and the AI off. */
  const buildSummary = () => {
    const s = new DischargeSummaryService(
      reg, lines, settings, w.cases, aiOf(stubProvider('none').p), new DocumentsService(m.ClinicalDocument), new TimelineService(m.TimelineEvent),
      m.DischargeSummary, m.DischargeOrder, m.DischargePlan, m.Admission, m.Bed, m.Ward, m.Patient, m.LabRequest, m.LabLine, m.PharmacyOrder, m.PharmacyLine,
      m.FollowUpItem, m.ProcedureBooking,
    );
    (s as any).logger = logger;
    return s;
  };
  /** Orders a discharge as Dr. Shajin, then waits for its summary, which is drafted in the background (R36). */
  const place = async (onPlan: string, input: OrderInput) => {
    const o = await orders.order(DOC, onPlan, input);
    await orders.idle();
    return o;
  };
  const stored = (id: unknown) => m.DischargeOrder.findById(id).lean<any>();
  const summaryOf = (orderId: unknown) => m.DischargeSummary.findOne({ order: orderId }).lean<any>();
  const lineOf = async (id: unknown, key: string) => (await stored(id)).lines.find((l: any) => l.key === key);
  const clocksOf = (orderId: unknown) => m.Clock.find({ ref: String(orderId) }).sort({ def: 1 }).lean<any[]>();
  /** The summary's AI: a recording stub of the given kind. Returns what the AI client is handed. */
  const useAi = (name: AiProviderName, answer?: unknown) => {
    const s = stubProvider(name, answer);
    (summary as any).ai = aiOf(s.p);
    return s.calls;
  };
  /** Home for now + 1 h, the window opening at once: two take-home medicines and a follow-up in 7 days with Dr. Shajin. */
  const home = (extra: Partial<OrderInput> = {}): OrderInput => ({
    kind: 'home', plannedLeaveAt: new Date(NOW.getTime() + 60 * MIN), diagnosis: DIAGNOSIS, condition: 'improved', note: NOTE,
    takeHome: { lines: [pantoprazole40, amoxicillin500] }, followUp: { inDays: 7, doctorId: String(shajin._id) }, ...extra,
  });
  /** Home for now + 1 h with nothing to take home and no follow-up. */
  const homeNone = (extra: Partial<OrderInput> = {}): OrderInput => ({
    kind: 'home', plannedLeaveAt: new Date(NOW.getTime() + 60 * MIN), diagnosis: DIAGNOSIS, condition: 'improved', note: NOTE, takeHome: 'none', followUp: 'none', ...extra,
  });
  const transfer = (): OrderInput => ({
    kind: 'transfer', plannedLeaveAt: new Date(NOW.getTime() + 60 * MIN), diagnosis: DIAGNOSIS, condition: 'stable', note: NOTE,
    receivingHospital: HOSPITAL, transferReason: TRANSFER_WHY, takeHome: 'none',
  });
  const died = (): OrderInput => ({ kind: 'died', diagnosis: DIAGNOSIS, timeOfDeath: at(26, 10, 40), causeOfDeath: CAUSE, note: NOTE });
  const planRow = (extra: Record<string, unknown> = {}) =>
    m.DischargePlan.create({
      admission: admissionId, case: caseId, patient: w.patientId, patientUhid: UHID, patientName: NAME,
      bedLabel: BED, wardName: WARD_NAME, doctor: 'Dr. Shajin', targetDay: '2026-09-26', targetAt: at(26, 11), state: 'planned', ...extra,
    });
  /** Another patient on their own ward case, with their own stay and plan. */
  const another = async (uhid: string, name: string) => {
    const p = await m.Patient.create({ uhid, name, age: 48, gender: 'Female', phone: '9100000077' });
    const onCase = String((await w.openWard(String(p._id), uhid, name)).case._id);
    const bed = await m.Bed.create({ ward: general._id, label: `GWA-${++seq + 20}`, number: seq + 20, state: 'occupied' });
    const adm = await m.Admission.create({
      patient: p._id, patientUhid: uhid, patientName: name, bed: bed._id, doctor: 'Dr. Shajin', department: 'General Medicine', roomClass: 'general',
      needs: [], notes: 'Chest pain', expectedStayDays: 2, status: 'active', admittedAt: at(25, 10), admittedBy: 'Front Desk',
    });
    const plan = await planRow({ admission: adm._id, patient: p._id, patientUhid: uhid, patientName: name, case: onCase, bedLabel: bed.label });
    return { patientId: String(p._id), caseId: onCase, planId: String(plan._id), bedLabel: bed.label };
  };
  /** A Lab request with its tests, on this stay's case unless told otherwise. */
  const labRequest = async (tests: Record<string, unknown>[], onCase: unknown = caseId) => {
    const r = await m.LabRequest.create({
      number: `LR-${String(++seq).padStart(4, '0')}`, patient: w.patientId, patientUhid: UHID, patientName: NAME, case: onCase,
      orderedBy: { id: DOC.id, name: DOC.name }, priority: 'urgent', orderedAt: at(24, 9), collectBy: new Date(),
    });
    const created = await m.LabLine.insertMany(tests.map((t) => ({ request: r._id, tatDueAt: new Date(), ...t })));
    return { requestId: String(r._id), lineIds: created.map((l) => String(l._id)) };
  };
  const procedure = (key: string, state: string, extra: Record<string, unknown> = {}, onCase: unknown = caseId) =>
    m.ProcedureBooking.create({
      number: `PR-${String(++seq).padStart(4, '0')}`, patient: w.patientId, patientUhid: UHID, patientName: NAME, case: onCase,
      procedure: key, priority: 'routine', status: state, requestedBy: { id: DOC.id, name: DOC.name }, earliest: at(24, 9), ...extra,
    });
  const pharmacyOrder = async (setting: 'Ward' | 'OPD', medicines: Record<string, unknown>[]) => {
    const o = await m.PharmacyOrder.create({
      number: `MO-${String(++seq).padStart(4, '0')}`, patient: w.patientId, patientUhid: UHID, patientName: NAME, case: caseId, setting,
      orderedBy: { id: DOC.id, name: DOC.name }, priority: 'routine', orderedAt: at(23, 12),
    });
    await m.PharmacyLine.insertMany(medicines.map((l) => ({ order: o._id, patient: w.patientId, route: 'oral', frequency: 'OD', ...l })));
    return o;
  };
  /**
   * The stay's record: three released results (critical, abnormal, normal) and one still to come, a procedure done,
   * and two medicines given on the ward. Each list also holds what must be left out.
   */
  const theStay = async () => {
    await labRequest([
      { test: 'troponin', status: 'released', releasedAt: at(24, 12), results: [row('Troponin I', 0.9, 'ng/mL', 'high', true)], critical: { active: true, ackAt: at(24, 12, 20), ackBy: DOC.name } },
      { test: 'crp', status: 'released', releasedAt: at(25, 9), results: [row('CRP', 3, 'mg/L')] },
      { test: 'cbc', status: 'released', releasedAt: at(25, 9), results: [row('Haemoglobin', 10.2, 'g/dL', 'low'), row('WBC', 7.1, '×10³/µL'), row('Platelets', 210, '×10³/µL')] },
      { test: 'lft', status: 'cancelled' },
    ]);
    const pending = await labRequest([{ test: 'urine', status: 'received' }]);
    // Another case's result is not this stay's.
    await labRequest([{ test: 'hba1c', status: 'released', releasedAt: at(25, 9), results: [row('HbA1c', 9.1, '%', 'high')] }], new Types.ObjectId());
    await procedure('echocardiogram', 'done', { doneAt: at(24, 15) });
    await procedure('chest-xray', 'booked');
    await procedure('upper-gi-endoscopy', 'done', { doneAt: at(24, 16) }, new Types.ObjectId());
    // Given on the ward: ceftriaxone (twice, one medicine) and enoxaparin (stopped after it was given); ibuprofen never given.
    await pharmacyOrder('Ward', [
      { medicine: 'ceftriaxone', dose: 1, unit: 'g', route: 'iv', frequency: 'BD', status: 'issued' },
      { medicine: 'ceftriaxone', dose: 1, unit: 'g', route: 'iv', frequency: 'BD', status: 'issued' },
      { medicine: 'enoxaparin', dose: 40, unit: 'mg', route: 'sc', status: 'stopped' },
      { medicine: 'ibuprofen', dose: 400, unit: 'mg', frequency: 'TDS', status: 'rejected' },
    ]);
    // An outpatient medicine on the same case was not part of the stay.
    await pharmacyOrder('OPD', [{ medicine: 'cetirizine', dose: 10, unit: 'mg', status: 'issued' }]);
    return { pending };
  };

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
    w = await buildWorld(m, { stubDischarge: false });
    w.registry.register({ key: 'scheduling', messageTypes: SCHEDULING_MESSAGE_TYPES, status });
    const settingsService = new SettingsService(m.HospitalSettings);
    settings = new DischargeSettingsService(settingsService);
    const rules = new RulesService(w.registry, settingsService, new CoordinatorEvents());
    reg = new DischargeRegistration(w.registry, w.messages, w.cases, settings, m.DischargePlan, m.DischargeOrder, m.Admission);
    logged = [];
    logger = { error: (x: string) => logged.push(x), warn: (x: string) => logged.push(x), log: () => undefined };
    (reg as any).logger = logger;
    reg.onModuleInit();
    const plans = new DischargePlansService(reg, w.messages, rules, settings, m.DischargePlan, m.Admission, m.Bed, m.Ward, m.Case, m.TaskAlertItem, m.Patient);
    const beds = new BedsService(m.Ward, m.Bed, m.Admission, new PatientsService(m.Patient), new BedEvents(), m.DischargeOrder);

    const opd = new OpdService(m.Department, m.OpDoctor, settingsService);
    await opd.createDepartment({ code: 'gen-med', name: 'General Medicine', tokenPrefix: 'G', icon: 'x', color: '#000000', order: 1, active: true });
    shajin = await opd.createDoctor({ name: 'Dr. Shajin', qualifications: '', departmentCode: 'gen-med', fee: 300, room: 'Room 101', tokenPrefix: 'G', sessions: ALL_DAY } as any);
    // No clinic sessions at all: a follow-up with her goes on the waitlist.
    meena = await opd.createDoctor({ name: 'Dr. Meena', qualifications: '', departmentCode: 'gen-med', fee: 300, room: 'Room 101', tokenPrefix: 'M', sessions: [] } as any);
    const doctors = new SchedulingDoctorsService(m.DoctorProfile, m.Appointment, opd);
    const appts = new SchedulingAppointmentsService(m.Appointment, m.Patient, doctors, opd, new AppointmentEvents());
    const waitlist = new SchedulingWaitlistService(m.WaitItem, m.Appointment, m.Patient, m.FollowUpItem, m.TaskAlertItem, doctors, appts, undefined as any);
    const followUps = new SchedulingFollowupsService(m.Patient, m.FollowUpItem, m.Case, opd, doctors, appts, waitlist, w.messages);

    lines = new DischargeLinesService(
      reg, w.messages, w.cases, m.DischargeOrder, m.DischargePlan, m.DischargeSummary, m.LabRequest, m.LabLine, m.PharmacyLine, m.FollowUpItem, m.Bill, m.ChargeLine,
    );
    (lines as any).logger = logger;
    lines.clock = () => NOW;
    summary = buildSummary();
    summary.clock = () => NOW;
    orders = new DischargeOrdersService(
      reg, plans, settings, w.cases, beds, w.takeHome, followUps, lines, summary, m.DischargePlan, m.DischargeOrder, m.DischargeSummary, m.PharmacyLine,
    );
    (orders as any).logger = logger;
    orders.clock = () => NOW;

    // The stay: admitted to the ICU on 23 Sep at 10:00, moved to the general ward a day later.
    const icu = await m.Ward.create({ code: 'ICU', name: 'Intensive care unit', shortName: 'ICU', floor: 1, type: 'icu', gender: 'any', ratePerDay: 8000 });
    general = await m.Ward.create({ code: 'GWA', name: WARD_NAME, shortName: 'Ward A', floor: 2, type: 'general', gender: 'male', ratePerDay: 1500 });
    const icuBed = await m.Bed.create({ ward: icu._id, label: 'ICU-2', number: 2, state: 'free' });
    const bed = await m.Bed.create({ ward: general._id, label: BED, number: 12, state: 'occupied' });
    caseId = String((await w.openWard()).case._id);
    const admission = await m.Admission.create({
      patient: w.patientId, patientUhid: UHID, patientName: NAME, bed: bed._id, doctor: 'Dr. Shajin', department: 'General Medicine', roomClass: 'general',
      needs: [], notes: REASON, expectedStayDays: 3, status: 'active', admittedAt: at(23, 10), admittedBy: 'Front Desk',
      transfers: [{ fromBed: icuBed._id, toBed: bed._id, at: at(24, 10), by: 'Nurse Anjali Thomas', reason: 'Stable' }],
    });
    admissionId = String(admission._id);
    await m.Bed.updateOne({ _id: bed._id }, { $set: { admission: admission._id } });
    planId = String((await planRow())._id);
  });
  afterEach(() => {
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
  });

  // ---------- drafting ----------

  test('the draft fills every section for Home from the record', async () => {
    await theStay();
    const o = await place(planId, home());
    const s = await summaryOf(o._id);
    assert.ok(s, 'the order drafts its summary');
    const followUp = await m.FollowUpItem.findById((await stored(o._id)).followUp.followUpId).lean<any>();
    assert.ok(followUp?.followUpDate && followUp.followUpTime, 'the follow-up is booked');
    assert.equal(s.kind, 'home');
    assert.deepEqual(Object.keys(s.sections), EDITABLE_SECTIONS('home'));
    assert.deepEqual(s.sections, {
      details: details('Date of discharge: 26 Sep 2026'),
      reason: REASON,
      diagnosis: DIAGNOSIS,
      procedures: 'Echocardiogram (24 Sep 2026)',
      results: RESULTS,
      condition: 'Improved',
      medicines: [PANTOPRAZOLE, AMOXICILLIN].join('\n'),
      followUp: `${followUp.followUpDate} at ${followUp.followUpTime} with Dr. Shajin`,
      warningSigns: DEFAULT_WARNING_SIGNS,
      note: NOTE,
    });
    // The AI is off in this world: the course is the rules' paragraph alone (R39: the note is its own section).
    assert.deepEqual(s.course, { text: STAY_COURSE, source: 'rules' });
    assert.deepEqual([s.edited, s.versions, s.signedAt, s.signedBy, s.documentId, s.draftedAt.getTime()], [[], [], undefined, undefined, undefined, NOW.getTime()]);

    // A follow-up that found no slot is on the waitlist.
    const mary = await another('MHK202600902', 'Mary Jeni');
    const waiting = await place(mary.planId, homeNone({ followUp: { inDays: 7, doctorId: String(meena._id) } }));
    assert.equal((await stored(waiting._id)).followUp.status, 'waitlisted');
    assert.equal((await summaryOf(waiting._id)).sections.followUp, 'On the waitlist: the desk will call with a time');

    // A take-home medicine cancelled in Pharmacy drops out when the summary is drafted again (nobody edited it).
    const amoxicillin = await m.PharmacyLine.findOne({ order: o.takeHomeOrder, medicine: 'amoxicillin' }).lean<any>();
    await w.checks.cancel(DOC, String(amoxicillin._id), 'Not needed after all');
    const again = await summary.draft(String(o._id));
    assert.equal(String(again._id), String(s._id), 'one summary per order');
    assert.equal((await summaryOf(o._id)).sections.medicines, PANTOPRAZOLE);
    assert.equal(await m.DischargeSummary.countDocuments({ order: o._id }), 1);
    assert.deepEqual(logged, []);
  });

  test('the transfer letter has receiving hospital and no follow-up', async () => {
    const { pending } = await theStay();
    const o = await place(planId, transfer());
    const s = await summaryOf(o._id);
    assert.ok(s, 'the order drafts its letter');
    assert.equal(s.kind, 'transfer');
    assert.deepEqual(Object.keys(s.sections), EDITABLE_SECTIONS('transfer'));
    assert.ok(!('followUp' in s.sections), 'no follow-up section');
    assert.deepEqual([s.sections.receivingHospital, s.sections.transferReason], [HOSPITAL, TRANSFER_WHY]);
    assert.equal(s.sections.details, details('Date of transfer: 26 Sep 2026'));
    assert.deepEqual([s.sections.condition, s.sections.medicines, s.sections.results, s.sections.note], ['Stable', 'None', RESULTS, NOTE]);
    assert.equal(s.course.text, STAY_COURSE.replace('improved', 'stable'));

    // R34: with no follow-up section, a result put off as "follow up later" is named for the receiving hospital.
    await lines.followUpLater(DOC, String(o._id), pending.requestId);
    await summary.draft(String(o._id));
    assert.equal((await summaryOf(o._id)).sections.results, `${RESULTS}\nResults still to come: Urine routine`);
    assert.deepEqual(logged, []);
  });

  test('the death summary has no medicines', async () => {
    await theStay();
    const o = await place(planId, died());
    const s = await summaryOf(o._id);
    assert.ok(s, 'the order drafts its death summary');
    assert.equal(s.kind, 'died');
    assert.deepEqual(Object.keys(s.sections), ['details', 'reason', 'diagnosis', 'procedures', 'results', 'timeOfDeath', 'causeOfDeath', 'note']);
    for (const gone of ['medicines', 'followUp', 'warningSigns', 'condition']) assert.ok(!(gone in s.sections), `no ${gone}`);
    assert.deepEqual([s.sections.timeOfDeath, s.sections.causeOfDeath, s.sections.note], ['26 Sep 2026, 10:40 AM', CAUSE, NOTE]);
    assert.equal(s.sections.details, details('Date of death: 26 Sep 2026'));
    // The course stops at the time of death and has no condition at discharge.
    assert.equal(s.course.text, `Admitted to the ICU for 1 day, then the general ward for 2 days. Echocardiogram. Investigations: Troponin I (critical), Complete blood count (abnormal), CRP (normal). Treated with 2 medicines.`);
    assert.deepEqual(logged, []);
  });

  test('the against-advice note says the risks were explained, and an optional follow-up not chosen is none booked', async () => {
    const o = await place(planId, { kind: 'against-advice', plannedLeaveAt: new Date(NOW.getTime() + 30 * MIN), diagnosis: DIAGNOSIS, condition: 'unchanged' });
    const s = await summaryOf(o._id);
    assert.ok(s, 'the order drafts its note');
    assert.equal(s.kind, 'against-advice');
    assert.deepEqual(Object.keys(s.sections), EDITABLE_SECTIONS('against-advice'));
    assert.equal(s.sections.condition, 'Unchanged. Leaving against medical advice: the risks were explained.');
    assert.match(s.sections.details, /^Date of leaving: 26 Sep 2026$/m);
    assert.deepEqual([s.sections.medicines, s.sections.followUp], ['None', 'None booked']);
    // No note for the summary: the note section is empty.
    assert.deepEqual(s.course, { text: BARE_COURSE.replace('improved', 'unchanged'), source: 'rules' });
    assert.equal(s.sections.note, '');
  });

  test('the AI input has no name, UHID, id, diagnosis or note', async () => {
    await theStay();
    const calls = useAi('claude');
    const o = await place(planId, home());
    assert.equal(calls.length, 1, 'one AI call, for the course paragraph');
    assert.deepEqual(calls[0].input, STAY_FACTS);
    const blob = JSON.stringify(calls[0]);
    const followUp = await m.FollowUpItem.findById((await stored(o._id)).followUp.followUpId).lean<any>();
    const secrets = [
      NAME, 'Ravi', 'Kumar', UHID, 'MHK', DIAGNOSIS, 'pneumonia', NOTE, 'unaided', REASON, 'breathless', BED, WARD_NAME, 'Dr. Shajin', 'Shajin', 'General Medicine',
      String(o._id), planId, admissionId, caseId, w.patientId, String(o.takeHomeOrder), 'LR-', 'MO-', 'PR-', 'CASE-', 'Sep', '2026', followUp.followUpDate,
      'Pantoprazole', 'Amoxicillin', 'ceftriaxone',
    ];
    for (const secret of secrets) assert.ok(!blob.includes(secret), `leaked ${secret}`);
    assert.ok(!leaks(blob), 'the leak check passes on the whole call');
    assert.ok(!/[a-f\d]{24}/i.test(blob) && !/\d{9,}/.test(blob));
    // The AI's answer is the course paragraph; the doctor's note (never sent) is its own section.
    const s = await summaryOf(o._id);
    assert.deepEqual([s.course, s.sections.note], [{ text: AI_TEXT, source: 'ai' }, NOTE]);
    assert.deepEqual(logged, []);
  });

  test('in sample mode the course is SAMPLE with source ai-sample', async () => {
    const calls = useAi('sample');
    const o = await place(planId, homeNone());
    const s = await summaryOf(o._id);
    assert.ok(s, 'the order drafts its summary');
    assert.deepEqual(s.course, { text: BARE_COURSE, source: 'ai-sample' }, 'canned: the rules paragraph, marked as a sample');
    assert.equal(calls.length, 0, 'no AI service is called in sample mode');
    // R13: with the AI off the rules paragraph is stored as the rules', not as the AI's.
    assert.ok((COURSE_SOURCES as readonly string[]).includes('rules'));
    useAi('none');
    await summary.redraftCourse(DOC, String(o._id));
    assert.deepEqual((await summaryOf(o._id)).course, { text: BARE_COURSE, source: 'rules' });
    assert.deepEqual(logged, []);
  });

  test('a leak in the AI answer falls back to the template', async () => {
    await theStay();
    useAi('claude', { text: `${NAME} (${UHID}) recovered well.` });
    const o = await place(planId, home());
    const id = String(o._id);
    assert.deepEqual((await summaryOf(id))?.course, { text: STAY_COURSE, source: 'rules' });
    // A gate-pass number is a leak too (GP- joins Revenue's list).
    useAi('claude', { text: 'Recovered well and left with gate pass GP-0007.' });
    await summary.redraftCourse(DOC, id);
    assert.deepEqual((await summaryOf(id)).course, { text: STAY_COURSE, source: 'rules' });
    for (const bad of ['GP-0001', 'gp-0042', 'BL-0042', 'LR-0016', 'MO-0004', 'MHK202600901', 'Dr. Shajin', '507f1f77bcf86cd799439011', 'call 9100000070']) {
      assert.ok(leaks(bad), bad);
    }
    for (const ok of [STAY_COURSE, BARE_COURSE, AI_TEXT]) assert.ok(!leaks(ok), ok);
    // A clean answer is used.
    useAi('claude');
    await summary.redraftCourse(DOC, id);
    assert.deepEqual((await summaryOf(id)).course, { text: AI_TEXT, source: 'ai' });
  });

  test('R16: an empty sections object round-trips, in a signed version too, and a named section saves in place', async () => {
    const s = await m.DischargeSummary.create({
      order: new Types.ObjectId(), kind: 'died', sections: {}, course: { text: '', source: 'staff' },
      versions: [{ sections: {}, course: { text: '', source: 'staff' }, signedBy: { id: DOC.id, name: DOC.name }, signedAt: NOW }],
    });
    let back = await m.DischargeSummary.findById(s._id).lean<any>();
    assert.deepEqual(back.sections, {});
    assert.deepEqual(back.versions[0].sections, {});
    await m.DischargeSummary.updateOne({ _id: s._id }, { $set: { 'sections.reason': 'Fever' } });
    back = await m.DischargeSummary.findById(s._id).lean<any>();
    assert.deepEqual(back.sections, { reason: 'Fever' });
  });

  test('R34: the follow-up section lists the results to review at follow-up', async () => {
    const { pending } = await theStay();
    const o = await place(planId, home());
    const id = String(o._id);
    const followUp = await m.FollowUpItem.findById((await stored(id)).followUp.followUpId).lean<any>();
    const booked = `${followUp.followUpDate} at ${followUp.followUpTime} with Dr. Shajin`;
    assert.equal((await summaryOf(id))?.sections?.followUp, booked);

    await lines.followUpLater(DOC, id, pending.requestId);
    await summary.draft(id);
    assert.equal((await summaryOf(id)).sections.followUp, `${booked}\nResults to review at follow-up: Urine routine`);
    // Released: it is a key result now, and nothing is left to review.
    await m.LabLine.updateOne({ _id: pending.lineIds[0] }, { $set: { status: 'released', releasedAt: at(26, 10), results: [row('Pus cells', 12, '/hpf', 'high')] } });
    await summary.draft(id);
    const s = await summaryOf(id);
    assert.equal(s.sections.followUp, booked);
    assert.equal(s.sections.results.split('\n')[2], 'Urine routine (abnormal), 26 Sep 2026: Pus cells 12 /hpf (high)', 'abnormal before normal');
  });

  test('drafting again follows the record, but never overwrites staff edits or a signed summary, and calls the AI once', async () => {
    const calls = useAi('claude');
    const o = await place(planId, homeNone());
    const id = String(o._id);
    // The doctor writes the results by hand; then a result is released and the diagnosis on the order changes.
    await summary.save(DOC, id, { results: 'Chest X-ray clear.' });
    await labRequest([{ test: 'crp', status: 'released', releasedAt: at(26, 10), results: [row('CRP', 3, 'mg/L')] }]);
    await orders.edit(DOC, id, { diagnosis: 'Pneumonia, resolved' });
    await summary.draft(id);
    let s = await summaryOf(id);
    assert.equal(s?.sections?.results, 'Chest X-ray clear.', 'an edit is never overwritten');
    assert.equal(s.sections.diagnosis, 'Pneumonia, resolved', 'what nobody edited follows the record');
    assert.deepEqual(s.edited, ['results']);
    assert.equal(calls.length, 1, 'drafting again never asks the AI again');

    // Signed, then unlocked: the summary is the doctor's from then on.
    await summary.sign(DOC, id);
    await orders.edit(DOC, id, { diagnosis: 'Pneumonia, resolved; anaemia' });
    await summary.draft(id);
    assert.equal((await summaryOf(id)).sections.diagnosis, 'Pneumonia, resolved');
    await summary.unlock(DOC, id);
    await summary.draft(id);
    s = await summaryOf(id);
    assert.equal(s.sections.diagnosis, 'Pneumonia, resolved');
    assert.equal(calls.length, 1);
  });

  test('the order drafts its summary, and a failing draft never undoes the order', async () => {
    const o = await place(planId, homeNone());
    assert.ok(await summaryOf(o._id), 'drafted once the order is saved');

    const mary = await another('MHK202600902', 'Mary Jeni');
    const real = summary.draft.bind(summary);
    summary.draft = async () => {
      throw new Error('database away');
    };
    const second = await place(mary.planId, homeNone());
    const row2 = await stored(second._id);
    assert.ok(row2, 'the order is saved');
    assert.equal(row2.state, 'ordered');
    assert.equal(await summaryOf(second._id), null);
    assert.ok(logged.some((x) => /summary not drafted/.test(x) && /database away/.test(x)), logged.join(' | '));
    // It can be drafted later, as the summary view does when there is none.
    summary.draft = real;
    const s = await summary.draft(String(second._id));
    assert.equal(s.sections.details.split('\n')[0], 'Name: Mary Jeni');
  });

  // ---------- staff edits, signing and re-signing ----------

  test('save after sign is 409', async () => {
    const o = await place(planId, homeNone());
    const id = String(o._id);
    await assert.rejects(summary.save(DOC, id, { nonsense: 'x' }), BadRequestException);
    await assert.rejects(summary.save(DOC, id, { course: 'x' }), BadRequestException, 'the course is its own field');
    await assert.rejects(summary.save(DOC, id, { followUpLater: 'x' } as any), BadRequestException);
    await assert.rejects(summary.save(DOC, id, { reason: 5 } as any), BadRequestException);
    await assert.rejects(summary.save(DOC, id, { reason: 'x'.repeat(5001) }), BadRequestException);
    await assert.rejects(summary.save(DOC, String(new Types.ObjectId()), { reason: 'x' }), NotFoundException);

    await summary.save(DOC, id, { reason: '  Fever and cough  ', diagnosis: DIAGNOSIS }, '  Recovered on oral antibiotics. ');
    let s = await summaryOf(id);
    assert.equal(s.sections.reason, 'Fever and cough');
    assert.deepEqual(s.edited, ['reason'], 'a section sent back unchanged is not an edit');
    assert.deepEqual(s.course, { text: 'Recovered on oral antibiotics.', source: 'staff' });

    await summary.sign(DOC, id);
    await assert.rejects(summary.save(DOC, id, { reason: 'Changed' }), ConflictException);
    await assert.rejects(summary.save(DOC, id, {}, 'Changed'), ConflictException);
    await assert.rejects(summary.redraftCourse(DOC, id), ConflictException);
    s = await summaryOf(id);
    assert.deepEqual([s.sections.reason, s.course.text], ['Fever and cough', 'Recovered on oral antibiotics.']);
  });

  test('sign makes one Signed document dated on the clinic day and a Timeline line, and sends summary-signed (stopping the summary clock)', async () => {
    process.env.CLINIC_DATE = '2026-09-26';
    const o = await place(planId, homeNone());
    const id = String(o._id);
    assert.deepEqual((await clocksOf(id)).map((c) => [c.def, c.state]), [['discharge-leave', 'running'], ['discharge-summary', 'running']]);

    // Its own clock: the clinic clock, the pinned day at the real time of day (the real day is weeks later).
    const signed = await buildSummary().sign(DOC, id);
    const s = await summaryOf(id);
    assert.equal(String(signed._id), String(s._id));
    assert.deepEqual(s.signedBy, { id: DOC.id, name: DOC.name });
    assert.equal(s.signedAt.toDateString(), NOW.toDateString(), 'signed on the clinic day');
    const docs = await m.ClinicalDocument.find().lean<any[]>();
    assert.equal(docs.length, 1, 'one document');
    const d = docs[0];
    assert.deepEqual(
      [d.uhid, d.category, d.title, d.status, d.signedBy, d.author, d.date, d.department],
      [UHID, 'Discharge Summary', 'Discharge summary', 'Signed', 'Dr. Shajin', 'Dr. Shajin', '26 Sep 2026', 'General Medicine'],
    );
    assert.match(d.signedOn, /^26 Sep 2026, \d{2}:\d{2} [AP]M$/);
    assert.equal(s.documentId, String(d._id));
    // The plain text of every section in order, the course with it, and who signed.
    assert.ok(d.description.startsWith(`Patient details\n${details('Date of discharge: 26 Sep 2026')}\n\nReason for admission\n${REASON}\n\n`), d.description);
    assert.ok(d.description.includes(`\n\nCourse in hospital\n${BARE_COURSE}\n\n${NOTE}\n\n`), d.description);
    const positions = HOME_HEADINGS.map((h) => d.description.indexOf(`${h}\n`));
    assert.ok(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])), `headings in order: ${positions.join(',')}`);
    assert.ok(d.description.endsWith(`\n\nSigned by Dr. Shajin on ${d.signedOn}`), d.description);

    const timeline = await m.TimelineEvent.find({ uhid: UHID, title: 'Discharge summary signed' }).lean<any[]>();
    assert.equal(timeline.length, 1, 'one Timeline line');
    assert.deepEqual([timeline[0].category, timeline[0].date, timeline[0].doctor, timeline[0].department], ['Admission', '26 Sep 2026', 'Dr. Shajin', 'General Medicine']);
    assert.equal(`${timeline[0].date}, ${timeline[0].time}`, d.signedOn);

    // discharge.summary-signed on the order's case, naming the bed and the kind, never the patient.
    const [message] = await w.sent('discharge.summary-signed');
    assert.deepEqual([String(message.case), message.summary], [caseId, `${BED}: Summary signed (Home)`]);
    assert.deepEqual(message.payload, { orderId: id, summaryId: String(s._id), bedLabel: BED, kind: 'home' });
    assert.ok((await stored(id)).announced.includes('discharge.summary-signed'));
    // It stops the summary clock; the leaving clock runs on.
    assert.deepEqual((await clocksOf(id)).map((c) => [c.def, c.state]), [['discharge-leave', 'running'], ['discharge-summary', 'met']]);
    // The lines are read again: the summary line is done by the doctor.
    const line = await lineOf(id, 'summary');
    assert.deepEqual([line.state, line.by, line.at.getTime()], ['done', { id: DOC.id, name: DOC.name }, s.signedAt.getTime()]);

    await assert.rejects(summary.sign(DOC, id), ConflictException, 'signed once');
    assert.equal(await m.ClinicalDocument.countDocuments(), 1);
    assert.equal((await w.sent('discharge.summary-signed')).length, 1);
    assert.deepEqual(logged, []);
  });

  test('a summary changed or signed while it is being signed is not signed again, and the extra document is archived', async () => {
    const o = await place(planId, homeNone());
    const id = String(o._id);
    // Something lands after the document is made and before the lock.
    const documents = (summary as any).documents as DocumentsService;
    const create = documents.create.bind(documents);
    let meanwhile: (() => Promise<unknown>) | null = null;
    documents.create = async (data) => {
      const made = await create(data);
      const run = meanwhile;
      meanwhile = null;
      await run?.();
      return made;
    };

    // An edit: the doctor never signs text they have not seen.
    meanwhile = () => summary.save(ADMIN, id, { reason: 'Changed meanwhile' });
    await assert.rejects(summary.sign(DOC, id), (e: unknown) => e instanceof ConflictException && /changed since you opened it/.test((e as Error).message));
    let s = await summaryOf(id);
    assert.deepEqual([s.signedAt, s.documentId, s.sections.reason], [undefined, undefined, 'Changed meanwhile']);
    assert.deepEqual((await m.ClinicalDocument.find().lean<any[]>()).map((d) => d.status), ['Archived']);
    assert.equal((await w.sent('discharge.summary-signed')).length, 0);

    // Another signature: it stands, with its own document; the second one is archived.
    meanwhile = () => summary.sign(ADMIN, id);
    await assert.rejects(summary.sign(DOC, id), (e: unknown) => e instanceof ConflictException && /already signed/.test((e as Error).message));
    s = await summaryOf(id);
    assert.deepEqual(s.signedBy, { id: ADMIN.id, name: ADMIN.name });
    const docs = await m.ClinicalDocument.find().sort({ _id: 1 }).lean<any[]>();
    assert.deepEqual(docs.map((d) => [d.signedBy, d.status]), [['Dr. Shajin', 'Archived'], ['Dr. Shajin', 'Archived'], ['Admin', 'Signed']]);
    assert.equal(s.documentId, String(docs[2]._id));
    assert.equal((await w.sent('discharge.summary-signed')).length, 1);
    assert.equal(await m.TimelineEvent.countDocuments({ uhid: UHID, title: 'Discharge summary signed' }), 1);
  });

  test('edit and re-sign archives the first document and keeps the version', async () => {
    const o = await place(planId, homeNone());
    const id = String(o._id);
    await assert.rejects(summary.unlock(DOC, id), ConflictException, 'nothing signed to unlock');
    await summary.sign(DOC, id);
    const first = await summaryOf(id);

    summary.clock = () => at(26, 11, 40);
    await summary.unlock(DOC, id);
    let s = await summaryOf(id);
    assert.deepEqual([s.signedAt, s.signedBy, s.documentId], [undefined, undefined, undefined], 'unlocked');
    assert.equal(s.versions.length, 1);
    const v = s.versions[0];
    assert.deepEqual(
      [v.sections, v.course, v.signedBy, v.signedAt.getTime(), v.documentId, v.unlockedBy, v.unlockedAt.getTime()],
      [first.sections, first.course, first.signedBy, first.signedAt.getTime(), first.documentId, { id: DOC.id, name: DOC.name }, at(26, 11, 40).getTime()],
    );
    assert.equal((await m.ClinicalDocument.findById(first.documentId).lean<any>()).status, 'Archived', 'kept, not deleted');
    // The summary line waits again, and the next signing is announced again.
    const waiting = await lineOf(id, 'summary');
    assert.deepEqual([waiting.state, waiting.detail], ['waiting', 'Unlocked: sign it again']);
    assert.ok(!(await stored(id)).announced.includes('discharge.summary-signed'));
    await assert.rejects(summary.unlock(DOC, id), ConflictException, 'unlocked once');

    // Edited and signed again by an admin: a second Signed document; the first stays archived.
    await summary.save(ADMIN, id, { diagnosis: 'Pneumonia, resolved' });
    summary.clock = () => at(26, 11, 50);
    await summary.sign(ADMIN, id);
    const docs = await m.ClinicalDocument.find().sort({ _id: 1 }).lean<any[]>();
    assert.deepEqual(docs.map((d) => d.status), ['Archived', 'Signed']);
    assert.match(docs[1].description, /\nFinal diagnosis\nPneumonia, resolved\n/);
    assert.deepEqual([docs[1].signedBy, docs[1].signedOn], ['Admin', '26 Sep 2026, 11:50 AM']);
    s = await summaryOf(id);
    assert.deepEqual([s.documentId, s.signedBy, s.versions.length], [String(docs[1]._id), { id: ADMIN.id, name: ADMIN.name }, 1]);
    // Each signing is its own message (a repeat within the Coordinator's minute must not be dropped).
    const sent = await w.sent('discharge.summary-signed');
    assert.deepEqual(sent.map((x) => x.dedupeKey), [`discharge.summary-signed:${id}:1`, `discharge.summary-signed:${id}:2`]);
    assert.equal(await m.TimelineEvent.countDocuments({ uhid: UHID, category: 'Admission', title: 'Discharge summary signed' }), 2);
    const done = await lineOf(id, 'summary');
    assert.deepEqual([done.state, done.by], ['done', { id: ADMIN.id, name: ADMIN.name }]);
    assert.deepEqual(logged, []);
  });

  test('a nurse cannot sign', async () => {
    const o = await place(planId, homeNone());
    const id = String(o._id);
    for (const who of [NURSE, DESK, PHARM, LAB]) {
      await assert.rejects(summary.sign(who, id), ForbiddenException, who.name);
      await assert.rejects(summary.save(who, id, { reason: 'x' }), ForbiddenException, who.name);
      await assert.rejects(summary.redraftCourse(who, id), ForbiddenException, who.name);
      await assert.rejects(summary.unlock(who, id), ForbiddenException, who.name);
    }
    const s = await summaryOf(id);
    assert.deepEqual([s.signedAt, s.sections.reason], [undefined, REASON]);
    assert.equal(await m.ClinicalDocument.countDocuments(), 0);
    assert.equal((await w.sent('discharge.summary-signed')).length, 0);
    // An admin may.
    await summary.sign(ADMIN, id);
    assert.equal(await m.ClinicalDocument.countDocuments(), 1);
  });

  test('a cancelled order has no summary work: no sign, no draft', async () => {
    const o = await place(planId, homeNone());
    const id = String(o._id);
    await orders.cancel(DOC, id, 'Spiked a fever');
    await assert.rejects(summary.sign(DOC, id), ConflictException);
    await assert.rejects(summary.save(DOC, id, { reason: 'x' }), ConflictException);
    await assert.rejects(summary.redraftCourse(DOC, id), ConflictException);
    const before = await summaryOf(id);
    await m.DischargeOrder.updateOne({ _id: id }, { $set: { diagnosis: 'Changed after the cancel' } });
    const again = await summary.draft(id);
    assert.equal(String(again._id), String(before._id));
    assert.deepEqual((await summaryOf(id)).sections, before.sections, 'drafting a cancelled order changes nothing');
    assert.equal(await m.ClinicalDocument.countDocuments(), 0);
  });

  // ---------- R38: save and sign what the doctor saw ----------

  const changedSince = (e: unknown) => e instanceof ConflictException && (e.getResponse() as { code?: string }).code === SUMMARY_CHANGED;

  test('R38: sign with a stale seen after a refresh is 409, with nothing signed and no Document; the current one signs', async () => {
    const o = await place(planId, homeNone());
    const id = String(o._id);
    const seen = (await summary.draft(id)).updatedAt!.toISOString();
    // A result is released, and the summary is read again from the record before the doctor presses Sign.
    await labRequest([{ test: 'crp', status: 'released', releasedAt: at(26, 10), results: [row('CRP', 3, 'mg/L')] }]);
    await summary.draft(id);
    const refreshed = await summaryOf(id);
    assert.equal(refreshed.sections.results, 'CRP, 26 Sep 2026: 3 mg/L', 'the refresh changed a section');

    await assert.rejects(summary.sign(DOC, id, seen), changedSince);
    let s = await summaryOf(id);
    assert.deepEqual([s.signedAt, s.signedBy, s.documentId], [undefined, undefined, undefined], 'nothing signed');
    assert.equal(await m.ClinicalDocument.countDocuments(), 0, 'no document');
    assert.equal((await w.sent('discharge.summary-signed')).length, 0);
    await assert.rejects(summary.sign(DOC, id, 'not a time'), BadRequestException);

    // Reloaded: the version the doctor sees now signs.
    await summary.sign(DOC, id, refreshed.updatedAt.toISOString());
    s = await summaryOf(id);
    assert.ok(s.signedAt);
    const [d] = await m.ClinicalDocument.find().lean<any[]>();
    assert.match(d.description, /\nKey results\nCRP, 26 Sep 2026: 3 mg\/L\n/);
  });

  test('R38: save with a stale seen is 409 and marks nothing edited; with the current seen, only real changes are edits', async () => {
    const o = await place(planId, homeNone());
    const id = String(o._id);
    const opened = (await summary.draft(id)).toObject() as any;
    // The editor sends every section back as it loaded them, with the reason rewritten.
    const sent = { ...opened.sections, reason: 'Fever and cough' };
    // Meanwhile the order's diagnosis changes and the summary follows it.
    await orders.edit(DOC, id, { diagnosis: 'Pneumonia, resolved' });
    await summary.draft(id);

    await assert.rejects(summary.save(DOC, id, sent, 'Recovered on oral antibiotics.', opened.updatedAt.toISOString()), changedSince);
    let s = await summaryOf(id);
    assert.deepEqual([s.edited, s.sections.reason, s.sections.diagnosis, s.course.source], [[], REASON, 'Pneumonia, resolved', 'rules'], 'nothing written');

    // Against the version reloaded, the sections sent back unchanged are not edits, and the refreshed diagnosis stays.
    const reloaded = await summaryOf(id);
    await summary.save(DOC, id, { ...reloaded.sections, reason: 'Fever and cough' }, undefined, reloaded.updatedAt.toISOString());
    s = await summaryOf(id);
    assert.deepEqual([s.edited, s.sections.reason, s.sections.diagnosis], [['reason'], 'Fever and cough', 'Pneumonia, resolved']);
    await assert.rejects(summary.save(DOC, id, {}, undefined, 'not a time'), BadRequestException);
  });

  // ---------- R39: the note is its own section; R40: a template course follows the record ----------

  test('R39: the note is its own section, refreshed from the order (also after an edit during the AI wait), never in course.text', async () => {
    const o = await place(planId, homeNone());
    const id = String(o._id);
    let s = await summaryOf(id);
    assert.deepEqual([s.sections.note, s.course.text], [NOTE, BARE_COURSE]);

    await orders.edit(DOC, id, { note: 'Home with family; diet as advised' });
    await summary.draft(id);
    s = await summaryOf(id);
    assert.equal(s.sections.note, 'Home with family; diet as advised');
    assert.ok(!s.course.text.includes('family'), 'course.text never holds the note');
    // The Document and the print show it after the course paragraph.
    assert.ok(summaryText(s.kind, s.sections, s.course).includes(`Course in hospital\n${BARE_COURSE}\n\nHome with family; diet as advised\n\n`));
    // A note written by hand is the doctor's: an order edit no longer moves it.
    await summary.save(DOC, id, { note: 'Written by hand' });
    await orders.edit(DOC, id, { note: 'Changed on the order' });
    await summary.draft(id);
    assert.equal((await summaryOf(id)).sections.note, 'Written by hand');

    // An order edit that lands while the background draft waits for the AI shows on the next draft.
    const mary = await another('MHK202600902', 'Mary Jeni');
    let answer!: (v: { text: string; sample: boolean; source: 'ai' | 'rules' }) => void;
    let asked!: () => void;
    const waiting = new Promise<void>((resolve) => (asked = resolve));
    (summary as any).ai = {
      course: () => {
        asked();
        return new Promise((resolve) => (answer = resolve));
      },
    };
    const second = await orders.order(DOC, mary.planId, homeNone());
    await waiting;
    await orders.edit(DOC, String(second._id), { note: 'Edited while the summary was drafting' });
    answer({ text: AI_TEXT, sample: false, source: 'ai' });
    await orders.idle();
    await summary.draft(String(second._id));
    s = await summaryOf(second._id);
    assert.deepEqual([s.sections.note, s.course.text], ['Edited while the summary was drafting', AI_TEXT]);
    assert.deepEqual(logged, []);
  });

  test("R40: a rules or sample course follows the record on refresh; the AI's or staff's paragraph never moves", async () => {
    // Rules: the condition changes on the order, and the paragraph with it.
    const o = await place(planId, homeNone());
    const id = String(o._id);
    await orders.edit(DOC, id, { condition: 'stable' });
    await summary.draft(id);
    let s = await summaryOf(id);
    assert.deepEqual([s.sections.condition, s.course], ['Stable', { text: BARE_COURSE.replace('improved', 'stable'), source: 'rules' }]);

    // Sample: the same template, still marked as the sample.
    useAi('sample');
    const mary = await another('MHK202600902', 'Mary Jeni');
    const b = await place(mary.planId, homeNone());
    assert.deepEqual((await summaryOf(b._id)).course, { text: 'Admitted to the general ward for 1 day. Condition at discharge: improved.', source: 'ai-sample' });
    await orders.edit(DOC, String(b._id), { condition: 'deteriorated' });
    await summary.draft(String(b._id));
    assert.deepEqual((await summaryOf(b._id)).course, { text: 'Admitted to the general ward for 1 day. Condition at discharge: deteriorated.', source: 'ai-sample' });

    // The AI's paragraph stays (only Redraft asks it again).
    useAi('claude');
    const john = await another('MHK202600903', 'John Paul');
    const c = await place(john.planId, homeNone());
    await orders.edit(DOC, String(c._id), { condition: 'stable' });
    await summary.draft(String(c._id));
    assert.deepEqual((await summaryOf(c._id)).course, { text: AI_TEXT, source: 'ai' });

    // So does the staff's.
    await summary.save(DOC, id, {}, 'Written by hand.');
    await orders.edit(DOC, id, { condition: 'improved' });
    await summary.draft(id);
    s = await summaryOf(id);
    assert.deepEqual([s.sections.condition, s.course], ['Improved', { text: 'Written by hand.', source: 'staff' }]);
  });

  // ---------- safety minors ----------

  test('M4: an identifier among the facts sends nothing, and only the coded fields ever reach the provider', async () => {
    const { p, calls } = stubProvider('claude');
    const leaky = { ...STAY_FACTS, procedures: ['MHK202600901'] };
    const r = await aiOf(p).course(leaky);
    assert.equal(calls.length, 0, 'no provider call');
    assert.deepEqual(r, { text: templateCourse(leaky), sample: false, source: 'rules' });

    const extra = {
      ...STAY_FACTS, patientName: NAME, uhid: UHID, note: NOTE,
      wards: [{ type: 'icu', days: 1, bed: BED }], tests: [{ name: 'CRP', flag: 'normal', value: 3, by: 'Dr. Shajin' }],
    } as unknown as CourseFacts;
    await aiOf(p).course(extra);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].input, { ...STAY_FACTS, wards: [{ type: 'icu', days: 1 }], tests: [{ name: 'CRP', flag: 'normal' }] });
    const blob = JSON.stringify(calls[0]);
    for (const secret of [NAME, UHID, NOTE, BED, 'Dr. Shajin']) assert.ok(!blob.includes(secret), `leaked ${secret}`);
  });

  test('M9: a failed re-read after the lock never turns a signature into an error: it stands, and the failure is logged', async () => {
    const o = await place(planId, homeNone());
    const id = String(o._id);
    // The summary's second look at the order (after the lock) fails, as a database blip would.
    let looks = 0;
    (summary as any).orders = new Proxy(m.DischargeOrder, {
      get(target, prop) {
        if (prop === 'findById') {
          return (...args: unknown[]) => {
            looks += 1;
            if (looks === 2) throw new Error('database away');
            return (target as any).findById(...args);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const signed = await summary.sign(DOC, id);
    assert.ok(signed.signedAt && signed.documentId);
    assert.equal(looks, 2);
    assert.equal((await m.ClinicalDocument.findById(signed.documentId).lean<any>()).status, 'Signed');
    assert.equal((await w.sent('discharge.summary-signed')).length, 1);
    assert.equal((await lineOf(id, 'summary')).state, 'done');
    assert.ok(logged.some((x) => /not read again after signing/.test(x) && /database away/.test(x)), logged.join(' | '));
  });

  test("M12: with only the patient's case to go on, records from before the admission are left out", async () => {
    // Neither the order nor the plan has a case; the patient's open case also holds an earlier visit.
    await m.DischargePlan.updateOne({ _id: planId }, { $unset: { case: 1 } });
    const order = await m.DischargeOrder.create({
      plan: planId, admission: admissionId, patient: w.patientId, kind: 'home', state: 'ordered', plannedLeaveAt: at(26, 12), windowAt: NOW,
      diagnosis: DIAGNOSIS, condition: 'improved', noTakeHome: true, noFollowUp: true, orderedBy: { id: DOC.id, name: DOC.name }, orderedAt: NOW,
    });
    // Admitted on 23 Sep at 10:00: the 20 Sep records are an earlier visit's.
    await labRequest([{ test: 'hba1c', status: 'released', releasedAt: at(20, 10), results: [row('HbA1c', 9.1, '%', 'high')] }]);
    await labRequest([{ test: 'crp', status: 'released', releasedAt: at(24, 10), results: [row('CRP', 3, 'mg/L')] }]);
    await procedure('upper-gi-endoscopy', 'done', { doneAt: at(20, 11) });
    await procedure('echocardiogram', 'done', { doneAt: at(24, 15) });
    await pharmacyOrder('Ward', [
      { medicine: 'ceftriaxone', status: 'issued', issued: { at: at(20, 12) } },
      { medicine: 'enoxaparin', status: 'issued', issued: { at: at(24, 12) } },
    ]);
    const s = await summary.draft(String(order._id));
    assert.equal(s.sections.results, 'CRP, 24 Sep 2026: 3 mg/L');
    assert.equal(s.sections.procedures, 'Echocardiogram (24 Sep 2026)');
    assert.equal(s.course.text, BARE_COURSE.replace('Condition', 'Echocardiogram. Investigations: CRP (normal). Treated with 1 medicine. Condition'));
  });

  // ---------- R35: a cancelled order's signed summary is archived ----------

  test('R35: cancel after sign archives the Document; the summary is kept for history, never current again', async () => {
    const o = await place(planId, homeNone());
    const id = String(o._id);
    await summary.sign(DOC, id);
    const signed = await summaryOf(id);
    assert.equal((await m.ClinicalDocument.findById(signed.documentId).lean<any>()).status, 'Signed');

    summary.clock = () => at(26, 11, 45);
    await orders.cancel(DOC, id, 'Spiked a fever');
    assert.equal((await m.ClinicalDocument.findById(signed.documentId).lean<any>()).status, 'Archived', 'archived, not deleted');
    assert.equal(await m.ClinicalDocument.countDocuments(), 1);
    const s = await summaryOf(id);
    assert.deepEqual(
      [s.signedAt?.getTime(), s.signedBy, s.documentId, s.sections, s.archivedAt?.getTime()],
      [signed.signedAt.getTime(), signed.signedBy, signed.documentId, signed.sections, at(26, 11, 45).getTime()],
      'kept for history, marked archived',
    );
    // Never current again: nothing to sign, a draft leaves it alone, and nobody can change it.
    assert.deepEqual(await summary.toSign(), []);
    await summary.draft(id);
    assert.deepEqual(await summaryOf(id), s);
    await assert.rejects(summary.unlock(DOC, id), ConflictException);
    await assert.rejects(summary.sign(DOC, id), ConflictException);
    assert.equal(await summary.archiveForCancel(id), false, 'once is enough');
    assert.deepEqual(logged, []);
  });

  test('R35: cancel with an unsigned summary changes no Document, and toSign no longer lists it', async () => {
    // An earlier stay's signed discharge summary is not this order's.
    const earlier = await m.ClinicalDocument.create({
      uhid: UHID, title: 'Discharge summary', category: 'Discharge Summary', status: 'Signed', date: '10 Jan 2026', signedBy: 'Dr. Ravi', signedOn: '10 Jan 2026, 10:00 AM',
    });
    const o = await place(planId, homeNone());
    const id = String(o._id);
    // Signed once and unlocked: its first document is archived already, and it waits to be signed again.
    await summary.sign(DOC, id);
    await summary.unlock(DOC, id);
    assert.deepEqual((await summary.toSign()).map((r) => r.orderId), [id]);
    const before = await summaryOf(id);
    const documents = await m.ClinicalDocument.find().sort({ _id: 1 }).lean<any[]>();
    assert.deepEqual(documents.map((d) => d.status), ['Signed', 'Archived']);

    await orders.cancel(DOC, id, 'Spiked a fever');
    assert.deepEqual(await m.ClinicalDocument.find().sort({ _id: 1 }).lean<any[]>(), documents, 'no document changed');
    assert.equal((await m.ClinicalDocument.findById(earlier._id).lean<any>()).status, 'Signed');
    assert.deepEqual(await summaryOf(id), before, 'the summary stays as it is');
    assert.deepEqual(await summary.toSign(), [], 'a cancelled order has nothing to sign');
    assert.deepEqual(logged, []);
  });

  test('R35: an order cancelled while its summary is being signed archives the new Document, and the sign is 409', async () => {
    const o = await place(planId, homeNone());
    const id = String(o._id);
    // The cancel lands after the sign made its document and before it took the lock.
    const documents = (summary as any).documents as DocumentsService;
    const create = documents.create.bind(documents);
    documents.create = async (data) => {
      const made = await create(data);
      documents.create = create;
      await orders.cancel(ADMIN, id, 'The plan changed');
      return made;
    };
    await assert.rejects(summary.sign(DOC, id), (e: unknown) => e instanceof ConflictException && /cancelled/.test((e as Error).message));
    const s = await summaryOf(id);
    assert.ok(s.signedAt && s.archivedAt, 'signed as the cancel landed, then archived');
    assert.deepEqual((await m.ClinicalDocument.find().lean<any[]>()).map((d) => d.status), ['Archived']);
    assert.equal((await w.sent('discharge.summary-signed')).length, 0, 'nothing to announce for a cancelled order');
    assert.equal(await m.TimelineEvent.countDocuments({ uhid: UHID, title: 'Discharge summary signed' }), 0);
  });

  test('R35: a failure archiving never undoes the cancel, and a later run finishes it', async () => {
    const o = await place(planId, homeNone());
    const id = String(o._id);
    await summary.sign(DOC, id);
    const documents = (summary as any).documents as DocumentsService;
    const archive = documents.archive.bind(documents);
    documents.archive = async () => {
      throw new Error('documents away');
    };
    assert.equal((await orders.cancel(DOC, id, 'Spiked a fever')).state, 'cancelled');
    assert.ok(logged.some((x) => /not archived after the cancel/.test(x) && /documents away/.test(x)), logged.join(' | '));
    let s = await summaryOf(id);
    assert.equal(s.archivedAt, undefined, 'left unmarked for a later run');
    documents.archive = archive;
    assert.equal(await summary.archiveForCancel(id), true);
    s = await summaryOf(id);
    assert.ok(s.archivedAt);
    assert.equal((await m.ClinicalDocument.findById(s.documentId).lean<any>()).status, 'Archived');

    // Even a summary service that throws never undoes a cancel.
    const mary = await another('MHK202600902', 'Mary Jeni');
    const second = await place(mary.planId, homeNone());
    summary.archiveForCancel = async () => {
      throw new Error('summary away');
    };
    assert.equal((await orders.cancel(DOC, String(second._id), 'Spiked a fever')).state, 'cancelled');
    assert.ok(logged.some((x) => /summary not archived after the cancel/.test(x) && /summary away/.test(x)), logged.join(' | '));
  });

  // ---------- R36: the order never waits for the AI ----------

  test('R36: ordering never waits for the AI: a slow answer fills the summary later, and a hanging one never holds the order', { timeout: 20_000 }, async () => {
    // Slow: the order returns at once, and the summary appears once the AI answers.
    let answer!: (v: { text: string; sample: boolean; source: 'ai' | 'rules' }) => void;
    let askedSlow!: () => void;
    const slowAsked = new Promise<void>((resolve) => (askedSlow = resolve));
    (summary as any).ai = {
      course: () => {
        askedSlow();
        return new Promise((resolve) => (answer = resolve));
      },
    };
    const o = await orders.order(DOC, planId, homeNone());
    const row = await stored(o._id);
    assert.deepEqual([row.state, !!row.windowOpenedAt, row.lines.length > 0], ['ordered', true, true], 'saved, window opened and lines read');
    await slowAsked;
    assert.equal(await summaryOf(o._id), null, 'the draft is waiting for the AI');
    answer({ text: AI_TEXT, sample: false, source: 'ai' });
    await orders.idle();
    assert.deepEqual((await summaryOf(o._id))?.course, { text: AI_TEXT, source: 'ai' });

    // Hanging: the order still returns, and reading the summary drafts it (the summary view heals a lost draft).
    const mary = await another('MHK202600902', 'Mary Jeni');
    let askedHung!: () => void;
    const hungAsked = new Promise<void>((resolve) => (askedHung = resolve));
    (summary as any).ai = {
      course: () => {
        askedHung();
        return new Promise(() => undefined);
      },
    };
    const second = await orders.order(DOC, mary.planId, homeNone());
    assert.equal((await stored(second._id)).state, 'ordered');
    await hungAsked;
    assert.equal(await summaryOf(second._id), null);
    const healed = await buildSummary().draft(String(second._id));
    assert.deepEqual([healed.course.source, healed.sections.details.split('\n')[0]], ['rules', 'Name: Mary Jeni']);
    assert.deepEqual(logged, []);
  });

  // ---------- the lists ----------

  test('toSign lists the unsigned summaries of open orders, oldest first', async () => {
    summary.clock = () => at(26, 9);
    const a = await place(planId, homeNone());
    const mary = await another('MHK202600902', 'Mary Jeni');
    summary.clock = () => at(26, 8);
    const b = await place(mary.planId, transfer());
    const john = await another('MHK202600903', 'John Paul');
    summary.clock = () => at(26, 10);
    const c = await place(john.planId, homeNone());
    await summary.sign(DOC, String(c._id));
    const anu = await another('MHK202600904', 'Anu Mathew');
    const d = await place(anu.planId, homeNone());
    await orders.cancel(DOC, String(d._id), 'Not going home yet');

    let rows = await summary.toSign();
    assert.deepEqual(rows.map((r) => r.orderId), [String(b._id), String(a._id)]);
    const sb = await summaryOf(b._id);
    assert.deepEqual(rows[0], {
      summaryId: String(sb._id),
      orderId: String(b._id),
      planId: mary.planId,
      kind: 'transfer',
      title: 'Transfer letter',
      patient: { id: mary.patientId, name: 'Mary Jeni', uhid: 'MHK202600902' },
      bedLabel: mary.bedLabel,
      wardName: WARD_NAME,
      doctor: 'Dr. Shajin',
      orderedBy: 'Dr. Shajin',
      draftedAt: at(26, 8).toISOString(),
      reopened: false,
      courseSource: 'rules',
    });
    // Unlocked for Edit and re-sign: back on the list, marked reopened.
    await summary.unlock(DOC, String(c._id));
    rows = await summary.toSign();
    assert.deepEqual(rows.map((r) => [r.orderId, r.reopened]), [[String(b._id), false], [String(a._id), false], [String(c._id), true]]);
  });

  // ---------- the AI's texts ----------

  test('the course template is the rules sentence, leaving out what the stay has none of', () => {
    assert.equal(templateCourse(STAY_FACTS), STAY_COURSE);
    assert.equal(templateCourse({ ...STAY_FACTS, wards: [{ type: 'private', days: 1 }], procedures: ['Coronary angiography', 'Echocardiogram'], tests: [{ name: 'CRP', flag: 'normal' }], medicineCount: 1, stayDays: 1 }),
      'Admitted to the private room for 1 day. Coronary angiography, Echocardiogram. Investigations: CRP (normal). Treated with 1 medicine. Condition at discharge: improved.');
    assert.equal(templateCourse({ kind: 'died', wards: [{ type: 'emergency', days: 0 }], procedures: [], tests: [], medicineCount: 0, condition: null, stayDays: 0 }),
      'Admitted to the emergency ward for less than a day.');
    assert.equal(templateCourse({ kind: 'home', wards: [], procedures: [], tests: [], medicineCount: 0, condition: 'stable', stayDays: 4 }),
      'Admitted for 4 days. Condition at discharge: stable.');
  });

  test('the day summary is built from counts alone, with the rules sentence when the AI is off', async () => {
    const counts = { dueToday: 6, noOrder: 2, clearing: 3, ready: 1, leftToday: 2, avgMinutes: 95, targetMinutes: 120, longestWait: { line: 'bill' as const, minutes: 140 } };
    const rules =
      '6 due today (2 with no order yet); 3 clearing; 1 ready to leave; 2 left today, 95 min on average from order to leaving (target 120 min); the longest wait is 140 min, waiting on the bill.';
    assert.equal(templateDaySummary(counts), rules);
    assert.equal(templateDaySummary({ ...counts, noOrder: 0, leftToday: 0, avgMinutes: null, longestWait: null }), '6 due today; 3 clearing; 1 ready to leave; 0 left today.');
    const { p, calls } = stubProvider('claude', { text: 'A steady day: most discharges wait on the bill.' });
    assert.deepEqual(await aiOf(p).daySummary(counts), { text: 'A steady day: most discharges wait on the bill.', sample: false, source: 'ai' });
    assert.deepEqual(calls[0].input, { ...counts, longestWait: { line: 'Nothing due on the bill', minutes: 140 } });
    assert.deepEqual(await aiOf(stubProvider('none').p).daySummary(counts), { text: rules, sample: false, source: 'rules' });
    assert.deepEqual(await aiOf(stubProvider('sample').p).daySummary(counts), { text: rules, sample: true, source: 'ai' });
    assert.deepEqual(await aiOf(stubProvider('claude', { text: 'GP-0003 left.' }).p).daySummary(counts), { text: rules, sample: false, source: 'rules' });
  });
});
