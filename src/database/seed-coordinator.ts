import mongoose, { Model, Schema, Types } from 'mongoose';
import { displayDate, displayTime, clinicNow } from '../common/utils/clinic-time';
import { hourOf } from '../common/utils/series';
import { Admission, AdmissionSchema } from '../modules/beds/schemas/admission.schema';
import { BedRequest, BedRequestSchema } from '../modules/beds/schemas/bed-request.schema';
import { DEFAULT_LADDERS, DEFAULT_TITLES } from '../modules/coordinator/escalations.service';
import { AgentMessage, AgentMessageSchema } from '../modules/coordinator/schemas/agent-message.schema';
import { Approval, ApprovalSchema } from '../modules/coordinator/schemas/approval.schema';
import { Case, CaseSchema } from '../modules/coordinator/schemas/case.schema';
import { ChatLog, ChatLogSchema } from '../modules/coordinator/schemas/chat-log.schema';
import { Clock, ClockSchema } from '../modules/coordinator/schemas/clock.schema';
import { CoordinatorCounter, CoordinatorCounterSchema } from '../modules/coordinator/schemas/coordinator-counter.schema';
import { CoordinatorSnapshot, CoordinatorSnapshotSchema } from '../modules/coordinator/schemas/coordinator-snapshot.schema';
import { DutyTitle, DutyTitleSchema } from '../modules/coordinator/schemas/duty-title.schema';
import { Escalation, EscalationSchema } from '../modules/coordinator/schemas/escalation.schema';
import { Ladder, LadderSchema } from '../modules/coordinator/schemas/ladder.schema';
import { Patient, PatientSchema } from '../modules/patients/schemas/patient.schema';
import { TaskAlertItem, TaskAlertItemSchema } from '../modules/tasks-alerts/schemas/task-alert.schema';
import { TimelineEvent, TimelineEventSchema } from '../modules/timeline/schemas/timeline.schema';
import { User, UserRole, UserSchema } from '../modules/users/schemas/user.schema';

// Loosely typed on purpose (see seed.ts).
const model = (cls: { name: string }, schema: Schema): Model<any> => mongoose.models[cls.name] ?? mongoose.model(cls.name, schema);

const MIN = 60_000;
const HOUR = 60 * MIN;
const CLOSE_REASON = 'Admission discharged or request cancelled';
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;
type Priority = keyof typeof PRIORITY_RANK;

/** A small repeatable number generator, so the history is the same on every seed. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Req {
  _id: Types.ObjectId;
  patient: Types.ObjectId;
  patientUhid: string;
  patientName: string;
  type: string;
  priority: Priority;
  state: string;
  open: boolean;
  admission?: Types.ObjectId;
  assignedBed?: Types.ObjectId;
  assignedBedLabel?: string;
  /** Clinic-clock times. */
  requestedAt: Date;
  stateSince: Date;
  assignedAt?: Date;
}

/**
 * Replaces everything the Coordinator keeps with demo history: cases and the messages the Bed
 * bridge would have written for the seeded bed requests, one open approval, one expired bed-wait
 * clock with its escalation, and a week of hourly snapshots. Run after seedBeds. Case times use the
 * clinic clock (`clinicDay`); messages, clocks, escalations and snapshots use the real clock,
 * placed so their order and spacing match the bed history.
 */
export async function seedCoordinator(clinicDay: string): Promise<void> {
  const cases = model(Case, CaseSchema);
  const messages = model(AgentMessage, AgentMessageSchema);
  const alerts = model(TaskAlertItem, TaskAlertItemSchema);
  const timeline = model(TimelineEvent, TimelineEventSchema);
  const requests = model(BedRequest, BedRequestSchema);
  const clocks = model(Clock, ClockSchema);
  const escalations = model(Escalation, EscalationSchema);
  const approvals = model(Approval, ApprovalSchema);
  const snapshots = model(CoordinatorSnapshot, CoordinatorSnapshotSchema);

  await Promise.all([
    cases.deleteMany({}),
    model(CoordinatorCounter, CoordinatorCounterSchema).deleteMany({}),
    messages.deleteMany({}),
    clocks.deleteMany({}),
    escalations.deleteMany({}),
    approvals.deleteMany({}),
    model(DutyTitle, DutyTitleSchema).deleteMany({}),
    model(Ladder, LadderSchema).deleteMany({}),
    snapshots.deleteMany({}),
    model(ChatLog, ChatLogSchema).deleteMany({}),
    alerts.deleteMany({ link: /^escalation:/ }),
    // The case milestones written below, and only those.
    timeline.deleteMany({ title: /^Case CASE-\d{4} (opened|closed)$/ }),
  ]);

  const admin =
    (await model(User, UserSchema).findOne({ email: 'admin@medios.ai' }).lean<any>()) ??
    (await model(User, UserSchema).findOne({ role: UserRole.ADMIN }).lean<any>());
  if (!admin) throw new Error('Coordinator seed: no admin user found. Seed the users first.');

  // Duty titles and ladders, as EscalationsService.ensureDefaults makes them; the admin holds two titles.
  const held = new Set(['duty-administrator', 'medical-superintendent']);
  await model(DutyTitle, DutyTitleSchema).insertMany(DEFAULT_TITLES.map((t) => ({ ...t, holders: held.has(t.key) ? [admin._id] : [] })));
  await model(Ladder, LadderSchema).insertMany(DEFAULT_LADDERS);

  // Clock mapping: a bed event at clinic time T happened at real time (now - (clinicNow - T)).
  const now = Date.now();
  const clinicMs = clinicNow(clinicDay).getTime();
  const real = (clinicTime: Date | number): Date => new Date(now - (clinicMs - new Date(clinicTime).getTime()));
  const clinicAgo = (minutes: number): Date => new Date(clinicMs - minutes * MIN);

  // A rerun replaces the requests made below (seedBeds' own past requests are all assigned and stay).
  await requests.deleteMany({ requestedBy: 'Seed', state: { $in: ['attention', 'waiting', 'cancelled'] } });

  // New open and cancelled requests, for patients who are not in a bed (the sample inpatients cover the rest).
  const admitted = new Set((await model(Admission, AdmissionSchema).find({ status: 'active' }).select('patient').lean<any[]>()).map((a) => String(a.patient)));
  const seenBefore = new Set((await requests.find().select('patient').lean<any[]>()).map((r) => String(r.patient)));
  const free = (await model(Patient, PatientSchema).find().sort({ uhid: 1 }).lean<any[]>()).filter((p) => !admitted.has(String(p._id)) && !seenBefore.has(String(p._id)));
  if (free.length < 2) throw new Error('Coordinator seed: needs at least two patients who are not admitted. Seed the patients first.');

  const fresh = (p: any, f: Record<string, unknown>) => {
    const priority = (f.priority as Priority) ?? 'medium';
    return {
      type: 'admission',
      patient: p._id,
      patientName: p.name,
      patientUhid: p.uhid,
      patientAge: p.age,
      patientGender: p.gender,
      stepDown: false,
      roomClass: 'general',
      needs: [],
      notes: '',
      department: 'General Medicine',
      doctor: p.doctor ?? 'Dr. Shajin',
      expectedStayDays: 3,
      priority,
      priorityRank: PRIORITY_RANK[priority],
      attempts: 0,
      requestedBy: 'Seed',
      requestedByName: 'Dr. Shajin',
      ...f,
    };
  };
  const [attentionPatient, waitingPatient, ...cancelPatients] = free;
  const toInsert = [
    // Needs a person: the notes mention a need that changes the ward.
    fresh(attentionPatient, {
      priority: 'high',
      notes: 'Productive cough for three weeks, possible TB. Please confirm isolation.',
      pendingNeeds: [{ need: 'isolation', evidence: 'possible TB' }],
      state: 'attention',
      stateReason: 'Notes mention isolation. A doctor needs to confirm it.',
      open: true,
      requestedAt: clinicAgo(20),
      stateSince: clinicAgo(19),
    }),
    // Waiting for 65 minutes: no bed fits.
    fresh(waitingPatient, {
      priority: 'high',
      needs: ['oxygen'],
      notes: 'Breathless on exertion, needs oxygen.',
      state: 'waiting',
      stateReason: 'No free bed has what this patient needs yet.',
      open: true,
      requestedAt: clinicAgo(66),
      stateSince: clinicAgo(65),
    }),
    ...cancelPatients.slice(0, 2).map((p, i) =>
      fresh(p, {
        priority: 'low',
        state: 'cancelled',
        stateReason: 'Cancelled by the doctor.',
        open: false,
        closedByName: 'Dr. Shajin',
        requestedAt: clinicAgo(300 + i * 150),
        stateSince: clinicAgo(270 + i * 150),
      }),
    ),
  ];
  const inserted = await requests.insertMany(toInsert);
  const attentionId = String(inserted[0]._id);
  const waitingId = String(inserted[1]._id);

  // One case per patient across all the bed requests.
  const all: Req[] = (await requests.find().sort({ requestedAt: 1 }).lean<any[]>()) as Req[];
  const admissionDocs = await model(Admission, AdmissionSchema).find({ _id: { $in: all.flatMap((r) => (r.admission ? [r.admission] : [])) } }).select('status').lean<any[]>();
  const admissionStatus = new Map(admissionDocs.map((a) => [String(a._id), a.status as string]));
  const byPatient = new Map<string, Req[]>();
  for (const r of all) byPatient.set(String(r.patient), [...(byPatient.get(String(r.patient)) ?? []), r]);

  type Plan = { id: Types.ObjectId; number: string; reqs: Req[]; closed: boolean; closedAt?: Date };
  const plans: Plan[] = [...byPatient.values()].map((reqs) => {
    const withAdmission = [...reqs].reverse().find((r) => r.admission);
    const closed = withAdmission ? admissionStatus.get(String(withAdmission.admission)) === 'discharged' : reqs.every((r) => !r.open);
    const closedAt = closed ? new Date(Math.max(...reqs.map((r) => r.stateSince.getTime()))) : undefined;
    return { id: new Types.ObjectId(), number: '', reqs, closed, closedAt };
  });
  plans.sort((a, b) => a.reqs[0].requestedAt.getTime() - b.reqs[0].requestedAt.getTime());
  plans.forEach((p, i) => (p.number = `CASE-${String(i + 1).padStart(4, '0')}`));

  await cases.insertMany(
    plans.map((p) => {
      const first = p.reqs[0];
      const rank = (r: Req) => PRIORITY_RANK[r.priority];
      const top = p.reqs.reduce((a, b) => (rank(b) < rank(a) ? b : a));
      const admissionId = [...p.reqs].reverse().find((r) => r.admission)?.admission;
      return {
        _id: p.id,
        number: p.number,
        patient: first.patient,
        patientUhid: first.patientUhid,
        patientName: first.patientName,
        kind: 'ipd',
        priority: top.priority,
        state: p.closed ? 'closed' : 'open',
        openedAt: first.requestedAt,
        ...(p.closed ? { closedAt: p.closedAt, closedReason: CLOSE_REASON } : {}),
        agents: ['bed'],
        refs: { bedRequestIds: p.reqs.map((r) => String(r._id)), ...(admissionId ? { admissionId: String(admissionId) } : {}) },
        openedBy: 'bed',
        createdAt: real(first.requestedAt),
        updatedAt: real(p.closedAt ?? first.requestedAt),
      };
    }),
  );
  await model(CoordinatorCounter, CoordinatorCounterSchema).create({ key: 'case', last: plans.length });

  // Messages, written the way the Bed bridge writes them. Summaries carry the UHID and bed label, never a name.
  const docs: Record<string, unknown>[] = [];
  let waitMessageId: Types.ObjectId | undefined;
  const push = (caseId: Types.ObjectId, at: Date, m: Record<string, unknown>): Types.ObjectId => {
    const _id = new Types.ObjectId();
    const key = `${m.type}:${caseId}:${String((m.payload as any)?.requestId ?? docs.length)}`;
    docs.push({
      _id,
      case: caseId,
      to: ['coordinator'],
      payload: {},
      dueBy: null,
      needsPerson: false,
      opensWork: false,
      hop: 0,
      attempts: 0,
      state: 'delivered',
      dedupeKey: key,
      createdAt: at,
      ...m,
    });
    return _id;
  };
  const milestones: Record<string, unknown>[] = [];
  const milestone = (uhid: string, clinicTime: Date, title: string, subtitle: string) =>
    milestones.push({ uhid, date: displayDate(clinicTime), time: displayTime(clinicTime), category: 'Admission', title, subtitle, status: 'Completed' });

  for (const [n, p] of plans.entries()) {
    const first = p.reqs[0];
    const uhid = first.patientUhid;
    const priority = first.priority;
    milestone(uhid, first.requestedAt, `Case ${p.number} opened`, 'Opened by the bed agent');
    push(p.id, real(first.requestedAt), { from: 'coordinator', type: 'case.opened', priority, summary: `${p.number} opened for ${uhid}` });
    for (const r of p.reqs) {
      const rp = r.priority;
      const requestedMsg = push(p.id, new Date(real(r.requestedAt).getTime() + 1000), {
        from: 'bed',
        type: 'bed.request',
        priority: rp,
        summary: `${uhid}: ${r.type} bed requested (${r.priority})`,
        payload: { requestId: String(r._id), requestType: r.type, priority: r.priority },
        opensWork: true,
      });
      const resolveWith = (resolver: Types.ObjectId, at: Date) => {
        const d = docs.find((x) => String(x._id) === String(requestedMsg))!;
        d.resolvedAt = at;
        d.resolvedBy = resolver;
      };
      // Some past requests waited a minute before a bed fit.
      if (r.state === 'assigned' && n % 3 === 1) {
        push(p.id, new Date(real(r.requestedAt).getTime() + MIN), { from: 'bed', type: 'bed.waiting', priority: rp, summary: `${uhid} is waiting for a bed`, payload: { requestId: String(r._id) } });
      }
      const at = real(r.assignedAt ?? r.stateSince);
      if (r.state === 'assigned') {
        const id = push(p.id, at, {
          from: 'bed',
          type: 'bed.assigned',
          priority: rp,
          summary: `${uhid} placed in ${r.assignedBedLabel ?? 'a bed'}`,
          payload: { bedId: String(r.assignedBed ?? ''), bedLabel: r.assignedBedLabel ?? '', admissionId: String(r.admission ?? ''), requestId: String(r._id) },
          resolves: requestedMsg,
        });
        resolveWith(id, at);
      } else if (r.state === 'waiting') {
        waitMessageId = push(p.id, at, { from: 'bed', type: 'bed.waiting', priority: rp, summary: `${uhid} is waiting for a bed`, payload: { requestId: String(r._id) } });
      } else if (r.state === 'attention') {
        push(p.id, at, { from: 'bed', type: 'bed.attention', priority: rp, summary: `${uhid}: bed request needs a person`, payload: { requestId: String(r._id) }, needsPerson: true });
      } else if (r.state === 'cancelled') {
        const id = push(p.id, at, {
          from: 'bed',
          type: 'bed.cancelled',
          priority: rp,
          summary: `Bed request for ${uhid} was cancelled`,
          payload: { requestId: String(r._id) },
          resolves: requestedMsg,
        });
        resolveWith(id, at);
      }
    }
    if (p.closed && p.closedAt) {
      push(p.id, new Date(real(p.closedAt).getTime() + 1000), { from: 'coordinator', type: 'case.closed', priority, summary: `${p.number} closed: ${CLOSE_REASON}`.slice(0, 140) });
      milestone(uhid, p.closedAt, `Case ${p.number} closed`, CLOSE_REASON);
    }
  }

  // The open approval: the attention request.
  const attentionPlan = plans.find((p) => p.reqs.some((r) => String(r._id) === attentionId))!;
  const attentionUhid = attentionPlan.reqs[0].patientUhid;
  await approvals.create({
    case: attentionPlan.id,
    type: 'bed.attention',
    agent: 'bed',
    summary: `Bed request for ${attentionUhid} needs a person`,
    roles: [UserRole.ADMIN, UserRole.DOCTOR],
    primary: { kind: 'open', label: 'Open' },
    source: { kind: 'bed-request', id: attentionId },
    state: 'open',
    createdAt: real(clinicAgo(19)),
  });

  // The escalation: the waiting request's bed-wait clock ran out about five minutes ago.
  const waitingPlan = plans.find((p) => p.reqs.some((r) => String(r._id) === waitingId))!;
  const expiredAt = new Date(now - 5 * MIN);
  const clockId = new Types.ObjectId();
  const escalationId = new Types.ObjectId();
  const alertId = new Types.ObjectId();
  const reason = 'Bed wait overdue';
  const dutyAdmin = DEFAULT_TITLES.find((t) => t.key === 'duty-administrator')!;
  const escalationText = `Escalated to ${dutyAdmin.label}: ${reason}`;
  await clocks.create({
    _id: clockId,
    def: 'bed-wait',
    case: waitingPlan.id,
    startedBy: waitMessageId,
    startedAt: real(clinicAgo(65)),
    dueAt: expiredAt,
    state: 'expired',
    escalation: escalationId,
    createdAt: real(clinicAgo(65)),
  });
  await alerts.create({
    _id: alertId,
    title: escalationText,
    subtitle: `On duty: ${admin.name}`,
    type: 'System',
    category: 'Critical',
    priority: 'High',
    status: 'Pending',
    link: `escalation:${escalationId}`,
    escalation: { id: String(escalationId), ladder: 'bed-wait', step: 0, titleKey: dutyAdmin.key, titleLabel: dutyAdmin.label, holderNames: [admin.name] },
    createdAt: expiredAt,
  });
  await escalations.create({
    _id: escalationId,
    case: waitingPlan.id,
    ladder: 'bed-wait',
    step: 0,
    reason,
    source: { kind: 'clock', id: String(clockId) },
    state: 'open',
    alert: alertId,
    raisedAt: expiredAt,
    stepAt: expiredAt,
  });
  push(waitingPlan.id, expiredAt, {
    from: 'coordinator',
    type: 'clock.expired',
    priority: 'high',
    summary: `${reason}`,
    payload: { clockKey: 'bed-wait' },
    causedBy: waitMessageId,
    dedupeKey: `clock.expired:${clockId}`,
  });
  push(waitingPlan.id, new Date(expiredAt.getTime() + 1000), {
    from: 'coordinator',
    type: 'escalation.raised',
    priority: 'high',
    summary: escalationText.slice(0, 140),
    payload: { reason },
    dedupeKey: `escalation.raised:${escalationId}`,
  });

  docs.sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
  await messages.insertMany(docs);
  await timeline.insertMany(milestones);

  // A week of hourly snapshots on the real clock, ending with the current hour.
  const r = rng(11202610);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const todayCount = docs.filter((d) => (d.createdAt as Date).getTime() >= midnight.getTime()).length;
  const openCases = plans.filter((p) => !p.closed).length;
  const last = hourOf(new Date(now)).getTime();
  const points = Array.from({ length: 168 }, (_, k) => {
    const i = 167 - k;
    const hour = new Date(last - i * HOUR);
    const h = hour.getHours();
    const current = i === 0;
    // Busier by day; open cases drift up over the week towards today's count.
    const curve = Math.sin(((h - 4) / 24) * 2 * Math.PI);
    const activeWorkflows = current ? openCases : Math.max(1, Math.round(openCases * (0.6 + 0.4 * (1 - i / 168)) + 2 * curve + (r() - 0.5) * 3));
    // Messages so far that day: climbs from midnight, resets at the next one.
    const tasksToday = current ? todayCount : Math.max(1, Math.round((6 + 38 * Math.min(1, (h + 1) / 18)) * (0.8 + r() * 0.4)));
    const escalationsOpen = current ? 2 : Math.max(0, Math.round(1 + curve + (r() - 0.3) * 2));
    return { hour, at: new Date(Math.min(now, hour.getTime() + 59 * MIN)), activeWorkflows, agentsOnline: 2, tasksToday, escalations: escalationsOpen };
  });
  await snapshots.insertMany(points);

  console.log(`✅ ${plans.length} cases, ${docs.length} messages, 1 approval, 1 escalation, ${points.length} snapshots`);
}
