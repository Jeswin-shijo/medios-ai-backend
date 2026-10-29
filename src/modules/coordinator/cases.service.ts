import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { clinicNow, displayDate, displayTime } from '../../common/utils/clinic-time';
import { TimelineService } from '../timeline/timeline.service';
import { AgentRegistry } from './agent-registry';
import { AgentKey, PRIORITY_RANK, Priority } from './coordinator-types';
import { MessagesService, MessageView } from './messages.service';
import { CASE_KINDS, Case, CaseDocument, CaseKind } from './schemas/case.schema';
import { CoordinatorCounter, CoordinatorCounterDocument } from './schemas/coordinator-counter.schema';

export interface OpenOrJoinInput {
  patientId: string;
  patientUhid: string;
  patientName: string;
  kind: CaseKind;
  priority: Priority;
  openedBy: AgentKey;
}

export interface CaseQuery {
  state?: 'open' | 'closed';
  limit?: number;
  before?: string;
}

const DUPLICATE_KEY = 11000;
const KIND_RANK: Record<CaseKind, number> = { opd: 0, er: 1, ipd: 2 };
const isOpen = { state: 'open' } as const;

/** A case is one patient's journey through the agents; at most one is open per patient. */
@Injectable()
export class CasesService {
  private readonly logger = new Logger(CasesService.name);

  constructor(
    @InjectModel(Case.name) private readonly model: Model<CaseDocument>,
    @InjectModel(CoordinatorCounter.name) private readonly counters: Model<CoordinatorCounterDocument>,
    private readonly messages: MessagesService,
    private readonly registry: AgentRegistry,
    private readonly timelineService: TimelineService,
  ) {
    // Any message on a case may be the last thing the close checks were waiting for.
    this.messages.onStored(async (m) => {
      if (!m.case) return;
      // The Coordinator's own open/close messages must not close a case (never at the instant it opens).
      if (m.from === 'coordinator' && (m.type === 'case.opened' || m.type === 'case.closed')) return;
      await this.evaluateClose(String(m.case));
    });
  }

  /** Takes the next case number. A create that then loses the 11000 race skips its number; that is fine. */
  private async nextNumber(): Promise<string> {
    const counter = await this.counters
      .findOneAndUpdate({ key: 'case' }, { $inc: { last: 1 } }, { upsert: true, new: true })
      .exec();
    return `CASE-${String(counter.last).padStart(4, '0')}`;
  }

  async openOrJoin(input: OpenOrJoinInput): Promise<{ case: CaseDocument; opened: boolean }> {
    if (!Types.ObjectId.isValid(input.patientId)) throw new BadRequestException('"patientId" is not a valid id');
    const patient = new Types.ObjectId(input.patientId);

    const existing = await this.model.findOne({ patient, ...isOpen }).exec();
    if (existing) return { case: await this.join(existing, input), opened: false };

    let created: CaseDocument;
    try {
      created = await this.model.create({
        number: await this.nextNumber(),
        patient,
        patientUhid: input.patientUhid,
        patientName: input.patientName,
        kind: input.kind,
        priority: input.priority,
        state: 'open',
        openedAt: clinicNow(),
        agents: [input.openedBy],
        refs: { bedRequestIds: [] },
        openedBy: input.openedBy,
      });
    } catch (e) {
      if ((e as { code?: number }).code !== DUPLICATE_KEY) throw e;
      // Lost the race to another call for the same patient: join the case that won.
      const winner = await this.model.findOne({ patient, ...isOpen }).exec();
      if (!winner) throw e;
      return { case: await this.join(winner, input), opened: false };
    }

    await this.messages.send({
      case: String(created._id),
      from: 'coordinator',
      to: ['coordinator'],
      type: 'case.opened',
      priority: created.priority,
      summary: `${created.number} opened for ${created.patientUhid}`,
      payload: {},
    });
    await this.safeMilestone(created, `Case ${created.number} opened`, `Opened by the ${input.openedBy} agent`);
    return { case: created, opened: true };
  }

  /** Adds the agent, lifts the kind (opd, er, ipd; never back) and keeps the higher priority. Each step is one atomic update. */
  private async join(existing: CaseDocument, input: OpenOrJoinInput): Promise<CaseDocument> {
    const _id = existing._id;
    await this.model.updateOne({ _id, ...isOpen }, { $addToSet: { agents: input.openedBy } }).exec();
    const lowerKinds = CASE_KINDS.filter((k) => KIND_RANK[k] < KIND_RANK[input.kind]);
    if (lowerKinds.length) await this.model.updateOne({ _id, ...isOpen, kind: { $in: lowerKinds } }, { $set: { kind: input.kind } }).exec();
    const lower = (Object.keys(PRIORITY_RANK) as Priority[]).filter((p) => PRIORITY_RANK[p] > PRIORITY_RANK[input.priority]);
    await this.model.updateOne({ _id, ...isOpen, priority: { $in: lower } }, { $set: { priority: input.priority } }).exec();
    return (await this.model.findById(_id).exec()) ?? existing;
  }

  async addRefs(caseId: string, refs: { bedRequestId?: string; admissionId?: string }): Promise<void> {
    if (!Types.ObjectId.isValid(caseId)) return;
    const update: Record<string, unknown> = {};
    if (refs.bedRequestId) update.$addToSet = { 'refs.bedRequestIds': refs.bedRequestId };
    if (refs.admissionId) update.$set = { 'refs.admissionId': refs.admissionId };
    if (Object.keys(update).length) await this.model.updateOne({ _id: caseId }, update).exec();
  }

  async addAgent(caseId: string, agent: AgentKey): Promise<void> {
    if (!Types.ObjectId.isValid(caseId)) return;
    await this.model.updateOne({ _id: caseId }, { $addToSet: { agents: agent } }).exec();
  }

  /** Closes the case when every registered close check passes. Returns true only for the call that closed it. */
  async evaluateClose(caseId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(caseId)) return false;
    const current = await this.model.findById(caseId).exec();
    if (!current || current.state === 'closed') return false;
    const checks = this.registry.closeChecks();
    if (!checks.length) return false;
    const passed: string[] = [];
    for (const c of checks) {
      const raw = await c.check(caseId);
      const result = raw === true ? 'pass' : raw === false ? 'fail' : raw;
      if (result === 'fail') return false;
      if (result === 'pass') passed.push(c.label);
    }
    // Every check abstained: nobody has vouched for the case yet.
    if (!passed.length) return false;

    const closedReason = passed.join('; ');
    const closed = await this.model
      .findOneAndUpdate({ _id: caseId, ...isOpen }, { $set: { state: 'closed', closedAt: clinicNow(), closedReason } }, { new: true })
      .exec();
    if (!closed) return false;
    await this.messages.send({
      case: caseId,
      from: 'coordinator',
      to: ['coordinator'],
      type: 'case.closed',
      priority: closed.priority,
      summary: `${closed.number} closed: ${closedReason}`.slice(0, 140),
      payload: {},
    });
    await this.safeMilestone(closed, `Case ${closed.number} closed`, closedReason);
    return true;
  }

  /** Runs the close check on every open case; returns how many closed. */
  async evaluateOpenCases(): Promise<number> {
    const open = await this.model.find(isOpen).select('_id').lean().exec();
    let closed = 0;
    for (const c of open) if (await this.evaluateClose(String(c._id))) closed += 1;
    return closed;
  }

  async get(id: string): Promise<CaseDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.model.findById(id).exec();
  }

  async byNumber(number: string): Promise<CaseDocument | null> {
    return this.model.findOne({ number }).exec();
  }

  countOpen(kind?: CaseKind): Promise<number> {
    return this.model.countDocuments({ ...isOpen, ...(kind ? { kind } : {}) }).exec();
  }

  /** The patient's open case, else their most recent one. */
  async forPatient(patientId: string): Promise<CaseDocument | null> {
    if (!Types.ObjectId.isValid(patientId)) return null;
    const patient = new Types.ObjectId(patientId);
    return (await this.model.findOne({ patient, ...isOpen }).exec()) ?? this.model.findOne({ patient }).sort({ openedAt: -1, _id: -1 }).exec();
  }

  async list(q: CaseQuery = {}): Promise<CaseDocument[]> {
    const match: Record<string, unknown> = {};
    if (q.state) match.state = q.state;
    if (q.before) {
      let at: Date | null = null;
      if (/^[a-f\d]{24}$/i.test(q.before)) {
        const ref = await this.model.findById(q.before).select('openedAt').lean().exec();
        at = ref?.openedAt ?? null;
      } else if (!isNaN(Date.parse(q.before))) {
        at = new Date(q.before);
      }
      if (!at) throw new BadRequestException('"before" must be a case id or an ISO time');
      match.openedAt = { $lt: at };
    }
    return this.model
      .find(match)
      .sort({ openedAt: -1, _id: -1 })
      .limit(Math.min(Math.max(q.limit ?? 50, 1), 500))
      .exec();
  }

  timeline(caseId: string): Promise<MessageView[]> {
    return this.messages.forCase(caseId);
  }

  /** A failed timeline write is logged; it must not undo the open or close. */
  private async safeMilestone(c: Pick<Case, 'patientUhid' | 'kind'>, title: string, subtitle: string): Promise<void> {
    try {
      await this.milestone(c, title, subtitle);
    } catch (e) {
      this.logger.error(`Timeline milestone failed: ${(e as Error).message}`);
    }
  }

  /** A line on the patient's own timeline: Emergency for an er case, Outpatient for opd, Admission for ipd. */
  async milestone(c: Pick<Case, 'patientUhid' | 'kind'>, title: string, subtitle: string): Promise<void> {
    const now = clinicNow();
    await this.timelineService.create({
      uhid: c.patientUhid,
      date: displayDate(now),
      time: displayTime(now),
      category: c.kind === 'ipd' ? 'Admission' : c.kind === 'opd' ? 'Outpatient' : 'Emergency',
      title,
      subtitle,
      status: 'Completed',
    });
  }
}
