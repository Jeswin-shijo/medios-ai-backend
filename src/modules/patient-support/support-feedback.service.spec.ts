import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { SupportRegistration } from './support-coordinator.registration';
import { SupportFactsService } from './support-facts.service';
import { SUPPORT_ACTOR } from './support-catalogue';
import { SupportSettingsService } from './support-settings.service';
import { SupportFeedbackService } from './support-feedback.service';
import { SupportTicketsService } from './support-tickets.service';

const MIN = 60_000;
const at = (h: number, min = 0, day = 26) => new Date(2026, 8, day, h, min, 0, 0);
const frontDesk = { id: 'u-desk', name: 'Anita Desk', role: UserRole.STAFF };

describe('SupportFeedbackService', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let clocks: ClocksService;
  let escalations: EscalationsService;
  let cases: CasesService;
  let feedback: SupportFeedbackService;
  let patient: any;
  let caseId: string;

  const sent = (type: string) => m.AgentMessage.find({ type }).sort({ createdAt: 1, _id: 1 }).lean();
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
    escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    clocks = new ClocksService(m.Clock, registry, messages, escalations);
    const settings = new SettingsService(m.HospitalSettings);
    cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    const reg = new SupportRegistration(registry, messages, m.SupportTicket, m.CheckupCall);
    reg.onModuleInit();
    const facts = new SupportFactsService(
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
    const svc = new SupportTicketsService(
      reg,
      new SupportSettingsService(settings),
      facts,
      cases,
      escalations,
      m.SupportTicket,
      m.TaskAlertItem,
      m.CoordinatorCounter,
      m.AgentCall,
      m.Patient
    );
    patient = await m.Patient.create({ uhid: 'MHK202600905', name: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000005' });
    caseId = String(
      (
        await cases.openOrJoin({
          patientId: String(patient._id),
          patientUhid: patient.uhid,
          patientName: 'Ravi Kumar',
          kind: 'ipd',
          priority: 'medium',
          openedBy: 'bed'
        })
      ).case._id
    );
    feedback = new SupportFeedbackService(reg, svc, cases, m.SupportFeedback, m.Patient);
  });

  test('a 5 at the desk with aspects is stored with band Good', async () => {
    const f = await feedback.record(frontDesk, {
      patientId: String(patient._id),
      source: 'desk',
      overall: 5,
      aspects: { communication: 5, waiting: 4 },
      comment: 'Lovely care'
    });
    assert.deepEqual([f.overall, f.band, f.complaint, f.ticketId, f.byName], [5, 'Good', false, null, 'Anita Desk']);
    assert.deepEqual(f.aspects, { communication: 5, waiting: 4 });
    assert.equal(await m.SupportTicket.countDocuments({}), 0);
    assert.equal((await feedback.list({}))[0].band, 'Good');
    await assert.rejects(feedback.record({ id: 'x', name: 'Lab', role: UserRole.LAB }, { source: 'desk', overall: 5 }), ForbiddenException);
  });

  test('a 2 opens a complaint ticket owned by the Patient relations officer and sends support.complaint', async () => {
    const f = await feedback.record(frontDesk, { patientId: String(patient._id), source: 'desk', overall: 2 });
    assert.equal(f.band, 'Poor');
    assert.ok(f.complaint);
    const t = await m.SupportTicket.findOne({}).lean();
    assert.ok(t);
    assert.deepEqual(
      [t.ticketType, t.owner, t.source, t.question, t.callerName, t.callerPhone],
      ['complaint', 'relations', 'feedback', 'Rated 2 of 5', 'Ravi Kumar', '9100000005']
    );
    assert.equal(String(t.feedback), f.id);
    assert.equal(f.ticketId, String(t._id));
    assert.equal(String((await m.SupportFeedback.findById(f.id).lean())?.ticket), String(t._id));
    const [msg] = await sent('support.complaint');
    assert.equal(msg.summary, `${t.number}: complaint from feedback (rated 2)`);
    assert.deepEqual([msg.payload.feedbackId, msg.payload.ticketId, msg.payload.number], [f.id, String(t._id), t.number]);
    assert.equal(String(msg.case), caseId);
  });

  test('the complaint tick on a 4 also opens one', async () => {
    const f = await feedback.record(frontDesk, { source: 'desk', overall: 4, complaint: true, comment: 'The room was dirty' });
    assert.equal(f.band, 'Good');
    const t = await m.SupportTicket.findOne({}).lean();
    assert.deepEqual([t?.question, t?.callerName, t?.patient], ['The room was dirty', 'Desk feedback', undefined]);
    assert.equal((await sent('support.complaint')).length, 1);
  });

  test('aspects on a call are refused', async () => {
    await assert.rejects(feedback.record(SUPPORT_ACTOR, { source: 'call', overall: 4, aspects: { staff: 4 } }), /only taken at the desk/);
    assert.equal((await feedback.record(SUPPORT_ACTOR, { source: 'call', overall: 3 })).band, 'Neutral');
  });

  test('a 6 is refused', async () => {
    for (const bad of [6, 0, 3.5, '4' as unknown as number])
      await assert.rejects(feedback.record(frontDesk, { source: 'desk', overall: bad }), /rating from 1 to 5/);
    await assert.rejects(feedback.record(frontDesk, { source: 'desk', overall: 4, aspects: { staff: 9 } }), /rating from 1 to 5/);
    await assert.rejects(feedback.record(frontDesk, { source: 'desk', overall: 4, comment: 'x'.repeat(501) }), /under 500/);
    assert.equal(await m.SupportFeedback.countDocuments({}), 0);
  });

  test('summary averages over 7 days and shows an aspect only when it has answers', async () => {
    const now = new Date(2026, 8, 26, 12);
    const day = 24 * 60 * 60_000;
    await feedback.record(frontDesk, { source: 'desk', overall: 5, aspects: { staff: 5 } }, new Date(now.getTime() - day));
    await feedback.record(frontDesk, { source: 'desk', overall: 4, aspects: { staff: 4 } }, new Date(now.getTime() - 2 * day));
    await feedback.record(SUPPORT_ACTOR, { source: 'call', overall: 3 }, new Date(now.getTime() - 3 * day));
    await feedback.record(frontDesk, { source: 'desk', overall: 1 }, new Date(now.getTime() - 9 * day));
    const s = await feedback.summary(7, now);
    assert.deepEqual([s.average, s.count], [4, 3]);
    assert.deepEqual(
      s.aspects.find((a) => a.key === 'staff'),
      { key: 'staff', label: 'Staff', average: 4.5, count: 2 }
    );
    assert.deepEqual(
      s.aspects.find((a) => a.key === 'facilities'),
      { key: 'facilities', label: 'Facilities', average: null, count: 0 }
    );
    assert.equal((await feedback.summary(30, now)).count, 4);
    assert.equal((await feedback.list({ complaintsOnly: true })).length, 1);
    assert.equal((await feedback.list({ limit: 2 })).length, 2);
  });
});
