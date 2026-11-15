import mongoose, { Model, Schema, Types } from 'mongoose';
import { clinicNow, isoDate, parseIsoDay } from '../common/utils/clinic-time';
import { Appointment, AppointmentSchema } from '../modules/appointments/schemas/appointment.schema';
import type { Actor } from '../modules/beds/actor';
import { Admission, AdmissionSchema } from '../modules/beds/schemas/admission.schema';
import { Bed, BedSchema } from '../modules/beds/schemas/bed.schema';
import { Ward, WardSchema } from '../modules/beds/schemas/ward.schema';
import { AgentCall, AgentCallSchema } from '../modules/calls/schemas/agent-call.schema';
import { AgentRegistry } from '../modules/coordinator/agent-registry';
import { CasesService } from '../modules/coordinator/cases.service';
import { ClocksService } from '../modules/coordinator/clocks.service';
import { CoordinatorEvents } from '../modules/coordinator/coordinator-events';
import { DEFAULT_TITLES, EscalationsService } from '../modules/coordinator/escalations.service';
import { MessagesService } from '../modules/coordinator/messages.service';
import { RulesService } from '../modules/coordinator/rules.service';
import { AgentMessage, AgentMessageSchema } from '../modules/coordinator/schemas/agent-message.schema';
import { Case, CaseSchema } from '../modules/coordinator/schemas/case.schema';
import { Clock, ClockSchema } from '../modules/coordinator/schemas/clock.schema';
import { CoordinatorCounter, CoordinatorCounterSchema } from '../modules/coordinator/schemas/coordinator-counter.schema';
import { DutyTitle, DutyTitleSchema } from '../modules/coordinator/schemas/duty-title.schema';
import { Escalation, EscalationSchema } from '../modules/coordinator/schemas/escalation.schema';
import { Ladder, LadderSchema } from '../modules/coordinator/schemas/ladder.schema';
import { atClinicTime } from '../modules/discharge/discharge-time';
import { DischargeOrder, DischargeOrderSchema } from '../modules/discharge/schemas/discharge-order.schema';
import { DischargePlan, DischargePlanSchema } from '../modules/discharge/schemas/discharge-plan.schema';
import { ErBaysService } from '../modules/er/er-bays.service';
import { ER_MESSAGE_TYPES } from '../modules/er/er-coordinator.registration';
import { ErTargetsService } from '../modules/er/er-targets.service';
import { ErVisitsService } from '../modules/er/er-visits.service';
import { ErBay, ErBaySchema } from '../modules/er/schemas/er-bay.schema';
import { ErExpected, ErExpectedSchema } from '../modules/er/schemas/er-expected.schema';
import { ErVisit, ErVisitSchema } from '../modules/er/schemas/er-visit.schema';
import { FollowUpItem, FollowUpItemSchema } from '../modules/follow-ups/schemas/follow-up.schema';
import { CheckupCall, CheckupCallSchema } from '../modules/patient-support/schemas/checkup-call.schema';
import { PatientUpdate, PatientUpdateSchema } from '../modules/patient-support/schemas/patient-update.schema';
import { SupportFaq, SupportFaqSchema } from '../modules/patient-support/schemas/support-faq.schema';
import { SupportFeedback, SupportFeedbackSchema } from '../modules/patient-support/schemas/support-feedback.schema';
import { SupportTemplate, SupportTemplateSchema } from '../modules/patient-support/schemas/support-template.schema';
import { SupportTicket, SupportTicketSchema } from '../modules/patient-support/schemas/support-ticket.schema';
import { SupportBridgeRegistration } from '../modules/patient-support/support-bridge.registration';
import { CareGroup, SUPPORT_ACTOR, SUPPORT_LADDERS } from '../modules/patient-support/support-catalogue';
import { SubmitCheckupInput, SupportCheckupsService } from '../modules/patient-support/support-checkups.service';
import { SUPPORT_CLOCKS, SupportRegistration } from '../modules/patient-support/support-coordinator.registration';
import { SaveContactInput, SupportFactsService } from '../modules/patient-support/support-facts.service';
import { RecordFeedbackInput, SupportFeedbackService } from '../modules/patient-support/support-feedback.service';
import { createMessageSender } from '../modules/patient-support/support-sender';
import { SupportSettingsService } from '../modules/patient-support/support-settings.service';
import { SupportTextsService } from '../modules/patient-support/support-texts.service';
import { OpenTicketInput, SupportTicketsService } from '../modules/patient-support/support-tickets.service';
import { SupportUpdatesService } from '../modules/patient-support/support-updates.service';
import { SUPPORT_START } from '../modules/patient-support/support.scheduler';
import { PatientsService } from '../modules/patients/patients.service';
import { Patient, PatientSchema } from '../modules/patients/schemas/patient.schema';
import { Bill, BillSchema } from '../modules/revenue/schemas/bill.schema';
import { SchedulingRosterService } from '../modules/scheduling/scheduling-roster.service';
import { SchedulingSettingsService } from '../modules/scheduling/scheduling-settings.service';
import { ProcedureBooking, ProcedureBookingSchema } from '../modules/scheduling/schemas/procedure-booking.schema';
import { RosterEntry, RosterEntrySchema } from '../modules/scheduling/schemas/roster-entry.schema';
import { StaffMember, StaffMemberSchema } from '../modules/scheduling/schemas/staff-member.schema';
import { HospitalSettings, HospitalSettingsSchema } from '../modules/settings/schemas/settings.schema';
import { SettingsService } from '../modules/settings/settings.service';
import { SupportBridge } from '../modules/support-bridge/support-bridge';
import { TaskAlertItem, TaskAlertItemSchema } from '../modules/tasks-alerts/schemas/task-alert.schema';
import { TimelineEvent, TimelineEventSchema } from '../modules/timeline/schemas/timeline.schema';
import { TimelineService } from '../modules/timeline/timeline.service';
import { User, UserRole, UserSchema } from '../modules/users/schemas/user.schema';

// Loosely typed on purpose (see seed.ts).
const model = (cls: { name: string }, schema: Schema): Model<any> => mongoose.models[cls.name] ?? mongoose.model(cls.name, schema);

const MIN = 60_000;
/** The family updates' catch-up cursor (SupportUpdatesService). */
const CATCH_UP = 'support-catchup';
/** The counters Patient Support keeps: ticket and check-up numbers, its start stamp and the catch-up cursor. */
const COUNTERS = ['support-ticket', 'support-checkup', SUPPORT_START, CATCH_UP];
const SUPPORT_CLOCK_KEYS = SUPPORT_CLOCKS.map((c) => c.key);
const SUPPORT_LADDER_KEYS = Object.keys(SUPPORT_LADDERS);

/** The models the seed reads and writes (one registration each, shared with the other seeds). */
function models() {
  return {
    User: model(User, UserSchema),
    Patient: model(Patient, PatientSchema),
    Appointment: model(Appointment, AppointmentSchema),
    Admission: model(Admission, AdmissionSchema),
    Bed: model(Bed, BedSchema),
    Ward: model(Ward, WardSchema),
    AgentCall: model(AgentCall, AgentCallSchema),
    AgentMessage: model(AgentMessage, AgentMessageSchema),
    Case: model(Case, CaseSchema),
    Clock: model(Clock, ClockSchema),
    CoordinatorCounter: model(CoordinatorCounter, CoordinatorCounterSchema),
    DutyTitle: model(DutyTitle, DutyTitleSchema),
    Escalation: model(Escalation, EscalationSchema),
    Ladder: model(Ladder, LadderSchema),
    TaskAlertItem: model(TaskAlertItem, TaskAlertItemSchema),
    TimelineEvent: model(TimelineEvent, TimelineEventSchema),
    HospitalSettings: model(HospitalSettings, HospitalSettingsSchema),
    DischargeOrder: model(DischargeOrder, DischargeOrderSchema),
    DischargePlan: model(DischargePlan, DischargePlanSchema),
    ErVisit: model(ErVisit, ErVisitSchema),
    ErExpected: model(ErExpected, ErExpectedSchema),
    ErBay: model(ErBay, ErBaySchema),
    FollowUpItem: model(FollowUpItem, FollowUpItemSchema),
    Bill: model(Bill, BillSchema),
    ProcedureBooking: model(ProcedureBooking, ProcedureBookingSchema),
    StaffMember: model(StaffMember, StaffMemberSchema),
    RosterEntry: model(RosterEntry, RosterEntrySchema),
    SupportTicket: model(SupportTicket, SupportTicketSchema),
    PatientUpdate: model(PatientUpdate, PatientUpdateSchema),
    CheckupCall: model(CheckupCall, CheckupCallSchema),
    SupportFeedback: model(SupportFeedback, SupportFeedbackSchema),
    SupportTemplate: model(SupportTemplate, SupportTemplateSchema),
    SupportFaq: model(SupportFaq, SupportFaqSchema)
  };
}

/**
 * The live Patient Support services, built by hand on the seed's models (as the specs do), on one registry with the
 * Support registration (its message types, clocks and rules) and the ER's message types (an expected arrival). The
 * registry holds no other agent, so its clock pass only ever expires Patient Support's clocks. No call is ever placed: the
 * check-up dial is a stub that says no. Messages go out in sample mode. Exported for the spec, which reads the seeded
 * records through the same services.
 */
export function wire() {
  const M = models();
  const registry = new AgentRegistry();
  const events = new CoordinatorEvents();
  const messages = new MessagesService(M.AgentMessage as never, registry, events);
  const escalations = new EscalationsService(
    M.Escalation as never,
    M.DutyTitle as never,
    M.Ladder as never,
    M.TaskAlertItem as never,
    M.User as never,
    messages,
    events
  );
  // Starts and stops the clocks the Support messages ask for; its checkDue raises the ladders of the overdue ones.
  const clocks = new ClocksService(M.Clock as never, registry, messages, escalations);
  const settingsService = new SettingsService(M.HospitalSettings as never);
  const rules = new RulesService(registry, settingsService, events);
  const timeline = new TimelineService(M.TimelineEvent as never);
  // No case closes while the seed runs: the cases service has an empty registry, so no close checks (as in seedDischarge).
  const cases = new CasesService(M.Case as never, M.CoordinatorCounter as never, messages, new AgentRegistry(), timeline);

  // The ER: only its expected-arrival door (an emergency check-up answer, an emergency call). Its message types are registered as the specs register them.
  registry.register({ key: 'er', messageTypes: ER_MESSAGE_TYPES, status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });
  const erVisits = new ErVisitsService(
    M.ErVisit as never,
    M.ErExpected as never,
    M.CoordinatorCounter as never,
    M.Patient as never,
    new PatientsService(M.Patient as never),
    undefined as never, // patient cards: an expected arrival never reads one
    cases,
    messages,
    new ErBaysService(M.ErBay as never, M.ErVisit as never),
    M.Clock as never,
    new ErTargetsService(settingsService)
  );
  // Scheduling: who is on duty, as the live roster answers (the Duty doctor and the cardiologist on call on the alerts).
  const roster = new SchedulingRosterService(
    M.StaffMember as never,
    M.RosterEntry as never,
    new SchedulingSettingsService(settingsService),
    escalations,
    M.User as never
  );
  roster.onModuleInit();

  // Patient Support.
  const supportSettings = new SupportSettingsService(settingsService);
  const registration = new SupportRegistration(registry, messages, M.SupportTicket as never, M.CheckupCall as never);
  registration.onModuleInit();
  const texts = new SupportTextsService(M.SupportTemplate as never, M.SupportFaq as never, settingsService, supportSettings);
  const facts = new SupportFactsService(
    M.Patient as never,
    M.Admission as never,
    M.Bed as never,
    M.Ward as never,
    M.ProcedureBooking as never,
    M.ErVisit as never,
    M.DischargeOrder as never,
    M.DischargePlan as never,
    M.Case as never,
    timeline
  );
  const updates = new SupportUpdatesService(
    registration,
    messages,
    texts,
    facts,
    supportSettings,
    settingsService,
    rules,
    createMessageSender('sample'),
    M.PatientUpdate as never,
    M.AgentMessage as never,
    M.Patient as never,
    M.Admission as never,
    M.ProcedureBooking as never,
    M.Bill as never,
    M.Appointment as never,
    M.FollowUpItem as never,
    M.DischargePlan as never,
    M.DischargeOrder as never,
    M.CoordinatorCounter as never
  );
  const tickets = new SupportTicketsService(
    registration,
    supportSettings,
    facts,
    cases,
    escalations,
    M.SupportTicket as never,
    M.TaskAlertItem as never,
    M.CoordinatorCounter as never,
    M.AgentCall as never,
    M.Patient as never
  );
  const feedback = new SupportFeedbackService(registration, tickets, cases, M.SupportFeedback as never, M.Patient as never);
  const bridge = new SupportBridge();
  // The demo places no calls: the check-up dial always says no (a check-up stays in To do for a person).
  const noCalls = {
    canCheckupCall: () => false,
    requestCheckup: async () => {
      throw new Error('The demo seed places no calls.');
    },
    cancel: async () => undefined
  };
  const checkups = new SupportCheckupsService(
    registration,
    messages,
    facts,
    feedback,
    texts,
    updates,
    supportSettings,
    escalations,
    noCalls as never,
    bridge,
    erVisits,
    roster,
    M.CheckupCall as never,
    M.Patient as never,
    M.DischargePlan as never,
    M.FollowUpItem as never,
    M.AgentCall as never,
    M.TaskAlertItem as never,
    M.CoordinatorCounter as never
  );
  // The phone agents' handlers on the bridge (a call-back, an unanswered call, an emergency call), as Calls reaches them.
  new SupportBridgeRegistration(bridge, tickets, texts, erVisits, M.Patient as never).onModuleInit();
  return {
    registry,
    messages,
    escalations,
    clocks,
    rules,
    cases,
    erVisits,
    roster,
    supportSettings,
    registration,
    texts,
    facts,
    updates,
    tickets,
    feedback,
    checkups,
    bridge
  };
}

/**
 * Replaces everything Patient Support keeps with a demo on top of the other agents' stories: contact and consent for nine
 * patients (Mohan Raj's son Ravi, in Tamil; David Raj's daughter Anitha), family updates made by replaying the messages
 * the earlier seeds stored since `seedStartedAtMs` through the live handlers (one held by the automatic switch), about
 * fifteen tickets in every status (two escalated through the real clock pass), seven check-up calls in every state and
 * about ten ratings over the week. Everything goes through the live services, with the front-desk login as the desk;
 * times in the past go through the services' clocks. No new logins. `support-start` is stamped at `nowMs` last, so the
 * live minute pass never replays the seeded messages. `nowMs` is for tests, which pin the clock (Date) to it as well.
 *
 * Run it from seed.ts after seedDischarge, with the moment the seeding started: it replays the messages the other seeds
 * sent. A second run on its own replaces only Patient Support's rows and gives the same demo.
 */
export async function seedSupport(clinicDay: string, seedStartedAtMs: number, nowMs: number = Date.now()): Promise<void> {
  if (Math.abs(Date.now() - nowMs) > 5 * MIN)
    throw new Error('Patient Support seed: nowMs must be the clock now (a test pins Date to it): the live services stamp their records with it.');
  // The services read "today" from CLINIC_DATE, which the seed may run without, so the clinic day is pinned while it runs.
  const savedClinic = process.env.CLINIC_DATE;
  process.env.CLINIC_DATE = clinicDay;
  try {
    await run(clinicDay, seedStartedAtMs, nowMs);
  } finally {
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
  }
}

async function run(clinicDay: string, seedStartedAtMs: number, nowMs: number): Promise<void> {
  const M = models();

  // ---- What the seed builds on, checked before anything is wiped ---------------------------------------
  const account = async (email: string): Promise<Actor> => {
    const u = await M.User.findOne({ email }).select('name role').lean<any>();
    if (!u) throw new Error(`Patient Support seed: no user ${email}. Seed the users first.`);
    return { id: String(u._id), name: u.name as string, role: u.role as UserRole };
  };
  const desk = await account('frontdesk@medios.ai');
  const admin = await account('admin@medios.ai');
  // The story patients, by name (generated UHIDs are not stable). A missing one is logged and its story skipped.
  const missing: string[] = [];
  const byName = async (name: string): Promise<any | null> => {
    const p = await M.Patient.findOne({ name }).sort({ uhid: 1 }).lean<any>();
    if (!p) missing.push(name);
    return p;
  };
  const mohan = await byName('Mohan Raj');
  const david = await byName('David Raj');
  const james = await byName('James Wilson');
  const meenakshi = await byName('Meenakshi T');
  const babu = await byName('Babu Thomas');
  await byName('Senthil Kumar R'); // no consent: his discharge pack is skipped
  const gopal = await byName('Gopal Krishnan');
  const rosamma = await byName('Rosamma Thomas');
  const saravanan = await byName('Saravanan K');
  const deepika = await byName('Deepika S');
  if (missing.length) console.warn(`⚠️ Patient Support seed: no patient named ${missing.join(', ')}; those stories are skipped.`);
  const idOf = (p: any | null): string | undefined => (p ? String(p._id) : undefined);

  // ---- The previous run's data, and nothing else, goes ------------------------------------------------
  await wipe(M);
  // Patient relations officer: the front-desk login (seedScheduling does the same; kept here for a database seeded without it).
  const relations = DEFAULT_TITLES.find((t) => t.key === 'patient-relations')!;
  await M.DutyTitle.updateOne(
    { key: relations.key },
    { $set: { holders: [new Types.ObjectId(desk.id)] }, $setOnInsert: { key: relations.key, label: relations.label } },
    { upsert: true }
  );

  const w = wire();
  await w.escalations.ensureDefaults();
  await w.texts.ensureDefaults();
  const cfg = await w.supportSettings.get();
  const since = new Date(seedStartedAtMs);
  /** A real moment `minutes` before the seed's now. */
  const ago = (minutes: number) => new Date(nowMs - minutes * MIN);

  // ---- 1. Contact and consent, recorded at the desk ------------------------------------------------------
  const record = async (p: any | null, input: SaveContactInput) => {
    if (p) await w.facts.saveContact(desk, String(p._id), { ...input, via: 'desk' });
  };
  await record(mohan, {
    preferredLanguage: 'ta',
    contacts: [{ name: 'Ravi', relation: 'Son', phone: '9000009300' }],
    updatesToIndex: 0,
    consent: { messages: true, calls: true }
  });
  await record(david, {
    preferredLanguage: 'en',
    contacts: [{ name: 'Anitha', relation: 'Daughter', phone: '9000009301' }],
    updatesToIndex: 0,
    consent: { messages: true, calls: false }
  });
  for (const p of [james, meenakshi, babu]) await record(p, { consent: { messages: true, calls: false } });
  for (const p of [gopal, rosamma, saravanan, deepika]) await record(p, { consent: { messages: true, calls: true } });

  // ---- 2. Family updates, by replaying the messages the other seeds stored ----------------------------------
  // One is held by the automatic switch: James Wilson's estimate, made while the switch is off.
  const jamesBill = james ? await M.Bill.findOne({ patient: james._id, kind: 'admission' }).sort({ createdAt: -1 }).lean<any>() : null;
  const heldSource = jamesBill
    ? await M.AgentMessage.findOne({ type: 'revenue.estimate-ready', 'payload.billId': String(jamesBill._id), createdAt: { $gte: since } })
        .sort({ createdAt: -1, _id: -1 })
        .lean<any>()
    : null;
  if (heldSource) {
    const wasOn = await w.rules.isOn('support-auto-updates');
    await w.rules.set(admin, 'support-auto-updates', false);
    try {
      await w.updates.fromMessage(String(heldSource._id));
    } finally {
      await w.rules.set(admin, 'support-auto-updates', wasOn);
    }
  } else if (james) {
    console.warn('⚠️ Patient Support seed: James Wilson has no estimate message to hold; the held update is skipped.');
  }
  // Everything else since the seeding started, a batch at a time until the catch-up cursor stops moving.
  const cursor = async () => ((await M.CoordinatorCounter.findOne({ key: CATCH_UP }).lean<any>())?.last as number | undefined) ?? null;
  for (let pass = 0; pass < 100; pass++) {
    const before = await cursor();
    await w.updates.catchUp(since);
    if ((await cursor()) === before) break;
  }
  // Sent now in sample mode, or (in quiet hours) left waiting for the minute pass at the end of them.
  for (let pass = 0; pass < 50; pass++) if (!(await w.updates.sendDue())) break;
  const waiting = await M.PatientUpdate.countDocuments({ status: 'waiting' });
  if (waiting) {
    console.warn(
      `⚠️ Patient Support seed: seeded in quiet hours (${cfg.quietStart} to ${cfg.quietEnd}): ${waiting} family updates wait until ${cfg.quietEnd}, when the minute pass sends them.`
    );
  }

  // ---- 3. Check-up calls -----------------------------------------------------------------------------------
  // The three who left today: from the replayed discharge.completed, two days after leaving (Coming up).
  const left = await M.AgentMessage.find({ type: 'discharge.completed', createdAt: { $gte: since } })
    .sort({ createdAt: 1, _id: 1 })
    .select('_id')
    .lean<any[]>();
  for (const msg of left) await w.checkups.fromDischarge(String(msg._id));
  // Four earlier patients went home two days before the clinic day at 11:00, so their check-ups are due today.
  const twoBack = parseIsoDay(clinicDay);
  twoBack.setDate(twoBack.getDate() - 2);
  const leftAt = atClinicTime(isoDate(twoBack), '11:00');
  const checkup = new Map<string, string>();
  for (const p of [gopal, rosamma, saravanan, deepika]) {
    if (p) checkup.set(String(p._id), String((await w.checkups.scheduleFor(String(p._id), leftAt, 'home', `seed:${p._id}`))._id));
  }
  // Due from the check-up hours' start on the clinic day; seeded earlier than that, they are made due as at its start.
  const opens = atClinicTime(clinicDay, cfg.checkupFrom);
  const clinicNowAt = clinicNow();
  await w.checkups.makeDue(clinicNowAt.getTime() >= opens.getTime() ? clinicNowAt : opens);
  const submit = async (p: any | null, input: (group: CareGroup) => SubmitCheckupInput) => {
    const id = p ? checkup.get(String(p._id)) : undefined;
    if (!id) return;
    const row = (await M.CheckupCall.findById(id).select('group').lean<any>())!;
    await w.checkups.submit(desk, id, input(row.group as CareGroup));
  };
  // Gopal Krishnan: the desk switches him to the cardiac list (design 4.5); chest pain, so the ER is told and expects him.
  await submit(gopal, () => ({ group: 'cardiac', answers: { medicines: 'yes', symptoms: 'severe' } }));
  // Rosamma Thomas: the cardiac list too; she is not taking both blood thinners, so a doctor must review her answers.
  await submit(rosamma, () => ({ group: 'cardiac', answers: { ...fineAnswers('cardiac'), antiplatelets: 'no' }, rating: 4 }));
  // Saravanan K: fine on his own list, and rates his stay 5. Deepika S stays due, in To do.
  await submit(saravanan, (group) => ({ group, answers: fineAnswers(group), rating: 5 }));

  // ---- 4. Ratings at the desk over the week (the call ratings came from the check-ups above) --------------------------
  const DAY_MIN = 24 * 60;
  const rate = (minutesAgo: number, input: Omit<RecordFeedbackInput, 'source'>) => w.feedback.record(desk, { source: 'desk', ...input }, ago(minutesAgo));
  await rate(6 * DAY_MIN + 180, {
    overall: 5,
    aspects: { communication: 5, staff: 5, waiting: 4, facilities: 4 },
    comment: 'The nurses explained everything clearly.'
  });
  await rate(5 * DAY_MIN + 60, { overall: 4, aspects: { waiting: 3, staff: 4 } });
  await rate(4 * DAY_MIN + 240, { overall: 5, aspects: { facilities: 5, staff: 5 }, comment: 'Clean rooms and friendly staff.' });
  await rate(3 * DAY_MIN + 120, { overall: 3, aspects: { waiting: 2, communication: 3 }, comment: 'Long wait at the pharmacy counter.' });
  await rate(2 * DAY_MIN + 300, { overall: 4 });
  await rate(DAY_MIN + 90, { patientId: idOf(james), overall: 4, aspects: { communication: 4, staff: 5 } });
  await rate(300, { overall: 5, comment: 'Quick registration at the kiosk.' });

  // ---- 5. Tickets, oldest first, each at its own moment (the tickets' clock); unanswered ones are recent enough not to be overdue,
  // except the two opened five hours back with no answer, which the clock pass below escalates ------------------------------
  const at = (minutes: number) => {
    w.tickets.now = () => ago(minutes);
  };
  const open = async (minutes: number, input: Omit<OpenTicketInput, 'source'>) => {
    at(minutes);
    return w.tickets.open(desk, { source: 'desk', ...input });
  };
  const caller = (p: any | null, fallback: string) => ({
    patientId: idOf(p),
    callerName: p?.name ?? fallback,
    callerPhone: p?.phone ? String(p.phone) : undefined
  });

  const copyBill = await open(360, {
    ...caller(meenakshi, 'Caller'),
    ticketType: 'billing',
    channel: 'phone',
    question: 'Asked for a printed copy of the final bill for her office.'
  });
  at(345);
  await w.tickets.note(desk, copyBill.id, 'The billing desk is printing a copy; told her it will wait at the counter.');
  at(320);
  await w.tickets.resolve(desk, copyBill.id, 'Copy kept at the billing counter; she collects it on her way out.');

  // Escalated: a clinical question nobody has answered (Duty doctor), and an urgent ward request (Ward nurse in charge).
  await open(300, {
    patientId: idOf(james),
    callerName: 'Mary Wilson (wife)',
    callerPhone: '9000009302',
    ticketType: 'clinical',
    channel: 'phone',
    question: 'His wife says he was breathless this morning and asks whether the doctor has seen him.'
  });
  await open(290, {
    patientId: idOf(david),
    callerName: 'Anitha (daughter)',
    callerPhone: '9000009301',
    ticketType: 'admission',
    channel: 'desk',
    urgent: true,
    question: 'Needs a bystander pass for tonight; the ward has not issued one yet.'
  });

  await open(240, {
    callerName: 'Visitor at the main desk',
    ticketType: 'directions',
    channel: 'desk',
    question: 'Asked where the cath lab waiting area is.',
    onTheSpot: true,
    resolution: 'Ground floor, behind the ER: showed the way.'
  });

  const saturday = await open(180, {
    ...caller(deepika, 'Caller'),
    ticketType: 'appointment',
    channel: 'phone',
    question: 'Wants to move her review to a Saturday morning.'
  });
  at(170);
  await w.tickets.note(desk, saturday.id, 'Rang back twice, no answer; left a message with the Saturday times.');
  at(169);
  await w.tickets.setState(desk, saturday.id, 'waiting');

  const goingHome = await open(150, {
    patientId: idOf(david),
    callerName: 'Anitha (daughter)',
    callerPhone: '9000009301',
    ticketType: 'discharge',
    channel: 'phone',
    question: 'Asked what time her father goes home today.'
  });
  at(140);
  await w.tickets.note(desk, goingHome.id, "Told her the discharge is ordered; the bill and the nurse's teaching are left.");
  at(100);
  await w.tickets.resolve(desk, goingHome.id, 'She will come at 4 PM to take him home.');

  const ecg = await open(120, {
    patientId: idOf(mohan),
    callerName: 'Ravi (son)',
    callerPhone: '9000009300',
    ticketType: 'reports',
    channel: 'desk',
    question: "Wants a copy of his father's ECG for their family doctor."
  });
  at(105);
  await w.tickets.setState(desk, ecg.id, 'in-progress');

  const tablets = await open(90, {
    ...caller(saravanan, 'Caller'),
    ticketType: 'medicines',
    channel: 'desk',
    question: 'Asked where to buy the tablets the doctor wrote.'
  });
  at(60);
  await w.tickets.resolve(desk, tablets.id, 'The pharmacy next to the ER is open 24 hours; showed the way.');

  // A call the phone agent could not finish, through the bridge as Calls opens it.
  at(50);
  await w.bridge.handlers.openCallTicket!({
    phone: '+919000009377',
    reason: 'Asked about visiting a patient in the ICU; the call ended needing staff.',
    urgent: false,
    providerCallId: 'demo-call-1',
    source: 'call-unanswered'
  });

  // Opened at the desk, then handed on to billing: a new round on the billing ladder.
  const topUp = await open(45, {
    patientId: idOf(james),
    callerName: 'Mary Wilson (wife)',
    callerPhone: '9000009302',
    ticketType: 'other',
    channel: 'desk',
    question: 'Asked why a top-up is due when an advance was paid at admission.'
  });
  at(30);
  await w.tickets.handOn(desk, topUp.id, 'billing', 'A question about the advance and the running bill.');

  await open(30, {
    callerName: 'Kumar',
    callerPhone: '9000009379',
    ticketType: 'directions',
    channel: 'phone',
    question: 'Asked whether two people can visit after 7 PM.'
  });
  await open(20, {
    ...caller(rosamma, 'Caller'),
    ticketType: 'appointment',
    channel: 'desk',
    question: 'Wants her cardiology review moved to an evening slot.'
  });

  // The 2-star rating at the desk: its complaint ticket goes to the Patient relations officer.
  at(15);
  await rate(15, {
    patientId: idOf(babu),
    overall: 2,
    aspects: { waiting: 1, communication: 2 },
    comment: 'Waited over an hour at the billing desk with no update.'
  });

  // An emergency call: the ER is told to expect him, and the desk rings the caller back at once.
  at(12);
  await w.bridge.handlers.expectedArrival!({
    complaint: 'Chest pain and sweating',
    ageSex: '58 M',
    minutes: 20,
    mode: 'walk-in',
    phone: '+919000009378',
    providerCallId: 'demo-call-2'
  });
  const emergency = (await M.SupportTicket.findOne({ providerCallId: 'demo-call-2' }).select('_id').lean<any>())!;
  at(9);
  await w.tickets.setState(desk, String(emergency._id), 'in-progress');
  at(8);
  await w.tickets.note(desk, String(emergency._id), 'Rang back: the family is driving him in, about 20 minutes away.');

  // An urgent call-back the phone agent booked for billing, with the number to ring back.
  at(10);
  await w.bridge.handlers.openCallTicket!({
    phone: '+919000009300',
    ...(mohan ? { uhid: mohan.uhid as string, callerName: 'Ravi (son)' } : {}),
    reason: 'Wants the angiography estimate explained before paying.',
    urgent: true,
    topic: 'billing',
    providerCallId: 'demo-call-3',
    source: 'call-back'
  });
  w.tickets.now = () => new Date();

  // ---- 6. The Coordinator's clock pass and Patient Support's own flag, as the minute passes run them ------------------
  const passAt = new Date();
  await w.clocks.checkDue(passAt);
  await w.tickets.markEscalated(passAt);

  // ---- 7. Start stamp, last: the live minute pass replays only messages after it ----------------------------------
  await M.CoordinatorCounter.updateOne({ key: SUPPORT_START }, { $set: { last: nowMs } }, { upsert: true });

  const count = async (filter: Record<string, unknown>) => M.PatientUpdate.countDocuments(filter);
  console.log(
    `✅ Patient Support: ${await count({})} family updates (${await count({ status: 'sample' })} sample, ${await count({ status: 'held' })} held, ` +
      `${await count({ status: 'skipped' })} skipped${waiting ? `, ${waiting} waiting for ${cfg.quietEnd}` : ''}), ` +
      `${await M.SupportTicket.countDocuments()} tickets (${await M.SupportTicket.countDocuments({ escalatedAt: { $ne: null } })} escalated), ` +
      `${await M.CheckupCall.countDocuments()} check-up calls, ${await M.SupportFeedback.countDocuments()} ratings, ` +
      `consent for ${await M.Patient.countDocuments({ 'consent.messages': true })} patients`
  );
}

/** Every answer fine, in the order of the group's questions (the rating is given apart). */
function fineAnswers(group: CareGroup): Record<string, string> {
  return {
    medicines: 'yes',
    symptoms: 'none',
    ...(group === 'cardiac' ? { antiplatelets: 'yes', exertion: 'no' } : {}),
    followup: 'yes',
    question: 'no'
  };
}

/** Deletes only Patient Support's rows (and the ER cards and Coordinator records its own work made), then rebuilds its indexes. */
async function wipe(M: ReturnType<typeof models>): Promise<void> {
  const oldClockIds = (
    await M.Clock.find({ def: { $in: SUPPORT_CLOCK_KEYS } })
      .select('_id')
      .lean<any[]>()
  ).map((c) => String(c._id));
  const oldEscalationIds = (
    await M.Escalation.find({ $or: [{ 'source.kind': 'clock', 'source.id': { $in: oldClockIds } }, { ladder: { $in: SUPPORT_LADDER_KEYS } }] })
      .select('_id')
      .lean<any[]>()
  ).map((e) => String(e._id));
  const oldCardIds = (await M.ErExpected.find({ byName: SUPPORT_ACTOR.name }).select('_id').lean<any[]>()).map((c) => String(c._id));
  await Promise.all([
    M.SupportTicket.deleteMany({}),
    M.PatientUpdate.deleteMany({}),
    M.CheckupCall.deleteMany({}),
    M.SupportFeedback.deleteMany({}),
    M.SupportTemplate.deleteMany({}),
    M.SupportFaq.deleteMany({}),
    M.AgentMessage.deleteMany({
      $or: [
        { from: 'patient-support' },
        { dedupeKey: { $in: [...oldClockIds.map((id) => `clock.expired:${id}`), ...oldEscalationIds.map((id) => `escalation.raised:${id}`)] } },
        { type: 'er.expected', 'payload.expectedId': { $in: oldCardIds } }
      ]
    }),
    M.Clock.deleteMany({ def: { $in: SUPPORT_CLOCK_KEYS } }),
    M.Escalation.deleteMany({ _id: { $in: oldEscalationIds } }),
    M.TaskAlertItem.deleteMany({ $or: [{ link: /^support-/ }, { link: { $in: oldEscalationIds.map((id) => `escalation:${id}`) } }] }),
    M.CoordinatorCounter.deleteMany({ key: { $in: COUNTERS } }),
    M.ErExpected.deleteMany({ _id: { $in: oldCardIds } }),
    // Only Patient Support writes the Communication category.
    M.TimelineEvent.deleteMany({ category: 'Communication' }),
    M.Patient.updateMany({}, { $unset: { preferredLanguage: '', contacts: '', updatesTo: '', consent: '' } })
  ]);
  for (const m of [M.SupportTicket, M.PatientUpdate, M.CheckupCall, M.SupportFeedback, M.SupportTemplate, M.SupportFaq]) await m.syncIndexes();
}
