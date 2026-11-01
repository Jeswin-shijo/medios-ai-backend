import * as assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import { Types } from 'mongoose';
import { parseIsoDay } from '../../common/utils/clinic-time';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AppointmentEvents } from '../appointments/appointment-events';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { RulesService } from '../coordinator/rules.service';
import { OpdService } from '../opd/opd.service';
import { PatientsService } from '../patients/patients.service';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { SchedulingAppointmentsService } from './scheduling-appointments.service';
import { SchedulingConflictsService } from './scheduling-conflicts.service';
import { SchedulingConsultsService } from './scheduling-consults.service';
import { SchedulingCoordinatorRegistration } from './scheduling-coordinator.registration';
import { SchedulingDoctorsService } from './scheduling-doctors.service';
import { SchedulingProceduresService } from './scheduling-procedures.service';
import { SchedulingReconcileService } from './scheduling-reconcile.service';
import { SchedulingRosterService } from './scheduling-roster.service';
import { SchedulingSettingsService } from './scheduling-settings.service';
import { SchedulingWaitlistService } from './scheduling-waitlist.service';

const SEC = 1000;
/** Tuesday 20 Oct 2026, 07:00 local; CLINIC_DATE unset, so the clinic clock is this clock. */
const NOW = () => new Date(2026, 9, 20, 7, 0, 0, 0);
const D = '2026-10-20';
const at = (hhmm: string) => {
  const d = parseIsoDay(D);
  const [h, mm] = hhmm.split(':').map(Number);
  d.setHours(h, mm, 0, 0);
  return d;
};

describe('SchedulingReconcileService', () => {
  const m = models();
  let savedClinic: string | undefined;
  let reconcile: SchedulingReconcileService;
  let patient: any;
  let caseId: Types.ObjectId;
  let seq = 0;

  const sent = (type: string) => m.AgentMessage.find({ type }).sort({ createdAt: 1, _id: 1 }).lean().exec() as Promise<any[]>;
  const booking = (over: Record<string, unknown> = {}) =>
    m.ProcedureBooking.create({
      number: `PR-${String(++seq).padStart(4, '0')}`,
      patient: patient._id,
      patientUhid: patient.uhid,
      patientName: 'Mohan Raj',
      case: caseId,
      procedure: 'coronary-angiography',
      priority: 'routine',
      status: 'booked',
      room: 'cath-lab',
      start: at('10:00'),
      end: at('10:45'),
      team: [],
      requestedBy: { id: 'u', name: 'Dr. X' },
      earliest: at('10:00'),
      ...over,
    });

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    savedClinic = process.env.CLINIC_DATE;
    delete process.env.CLINIC_DATE;
    mock.timers.enable({ apis: ['Date'], now: NOW() });
    await resetTestDb();
    seq = 0;
    const registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    const messages = new MessagesService(m.AgentMessage, registry, events);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    new ClocksService(m.Clock, registry, messages, escalations);
    const cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    const settingsService = new SettingsService(m.HospitalSettings);
    const settings = new SchedulingSettingsService(settingsService);
    const rules = new RulesService(registry, settingsService, events);
    const roster = new SchedulingRosterService(m.StaffMember, m.RosterEntry, settings, escalations);
    roster.onModuleInit();
    const consults = new SchedulingConsultsService(
      m.ConsultRequest, m.StaffMember, m.OpDoctor, m.Department, m.CoordinatorCounter, m.TaskAlertItem,
      new PatientsService(m.Patient), cases, messages, settings, roster, escalations,
    );
    new SchedulingCoordinatorRegistration(registry, m.ConsultRequest, m.ProcedureBooking, m.Clock, consults, messages).onModuleInit();
    const procedures = new SchedulingProceduresService(
      m.ProcedureBooking, m.RoomBlock, m.StaffMember, m.RosterEntry, m.Appointment, m.OpDoctor, m.SchedulingLock,
      m.CoordinatorCounter, m.TaskAlertItem, new PatientsService(m.Patient), cases, messages, settings, rules, m.WaitItem,
    );
    const opd = new OpdService(m.Department, m.OpDoctor, settingsService);
    const doctors = new SchedulingDoctorsService(m.DoctorProfile, m.Appointment, opd);
    const appts = new SchedulingAppointmentsService(m.Appointment, m.Patient, doctors, opd, new AppointmentEvents());
    const waitlist = new SchedulingWaitlistService(m.WaitItem, m.Appointment, m.Patient, m.FollowUpItem, m.TaskAlertItem, doctors, appts, procedures);
    waitlist.onModuleInit();
    const conflicts = new SchedulingConflictsService(m.Appointment, m.ProcedureBooking, m.RoomBlock, m.OpDoctor, m.StaffMember, m.WaitItem, m.TaskAlertItem, doctors, roster, escalations);
    reconcile = new SchedulingReconcileService(m.ProcedureBooking, m.ConsultRequest, m.WaitItem, procedures, consults, waitlist, conflicts);
    patient = await m.Patient.create({ uhid: 'MHK202600971', name: 'Mohan Raj', age: 58, gender: 'Male', phone: '9100000071' });
    const c = await cases.openOrJoin({ patientId: String(patient._id), patientUhid: patient.uhid, patientName: 'Mohan Raj', kind: 'er', priority: 'high', openedBy: 'er' });
    caseId = c.case._id as Types.ObjectId;
  });
  afterEach(() => {
    mock.timers.reset();
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
  });

  test('reconcile re-sends a booked message whose announcedAt is missing, once', async () => {
    const b = await booking();
    mock.timers.tick(10 * SEC);
    await reconcile.reconcile();
    assert.equal((await sent('scheduling.procedure-booked')).length, 0, 'younger than 30 s: left alone');

    mock.timers.tick(30 * SEC);
    await reconcile.reconcile();
    const first = await sent('scheduling.procedure-booked');
    assert.equal(first.length, 1);
    assert.equal(first[0].payload.bookingId, String(b._id));
    assert.ok(!first[0].summary.includes('Mohan'));
    assert.ok((await m.ProcedureBooking.findById(b._id).lean())!.announcedAt, 'marked sent');

    mock.timers.tick(60 * SEC);
    await reconcile.reconcile();
    assert.equal((await sent('scheduling.procedure-booked')).length, 1, 'not sent again');
  });

  test('an open procedure wait item whose booking is booked becomes resolved', async () => {
    const b = await booking({ announcedAt: new Date() });
    const item = await m.WaitItem.create({
      kind: 'procedure', refId: b._id, reason: 'bumped', priority: 'routine', patient: patient._id,
      patientUhid: patient.uhid, patientName: 'Mohan Raj', original: { start: at('09:00') },
    });
    const cancelled = await booking({ status: 'cancelled', announcedAt: new Date() });
    const other = await m.WaitItem.create({
      kind: 'procedure', refId: cancelled._id, reason: 'bumped', priority: 'routine', patient: patient._id,
      patientUhid: patient.uhid, patientName: 'Mohan Raj', original: { start: at('09:00') },
    });
    const waiting = await booking({ status: 'cant-book', announcedAt: new Date() });
    const still = await m.WaitItem.create({
      kind: 'procedure', refId: waiting._id, reason: 'bumped', priority: 'routine', patient: patient._id,
      patientUhid: patient.uhid, patientName: 'Mohan Raj', original: { start: at('09:00') },
    });

    mock.timers.tick(40 * SEC);
    await reconcile.reconcile();
    assert.equal((await m.WaitItem.findById(item._id).lean())!.status, 'resolved');
    assert.ok((await m.WaitItem.findById(item._id).lean())!.resolvedAt);
    assert.equal((await m.WaitItem.findById(other._id).lean())!.status, 'cancelled');
    assert.equal((await m.WaitItem.findById(still._id).lean())!.status, 'open', 'still waiting for a slot');
  });
});
