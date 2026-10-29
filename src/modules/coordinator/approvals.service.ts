import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Actor } from '../beds/actor';
import { UserRole } from '../users/schemas/user.schema';
import { AgentRegistry } from './agent-registry';
import { MessagesService } from './messages.service';
import { Approval, ApprovalDocument } from './schemas/approval.schema';
import { DutyTitle, DutyTitleDocument } from './schemas/duty-title.schema';

export interface ApprovalView {
  id: string;
  case: string | null;
  type: string;
  agent: string;
  summary: string;
  roles: string[];
  primary: { kind: 'approve' | 'open'; label: string };
  source: { kind: string; id: string } | null;
  state: string;
  assignedTo: { kind: 'title' | 'role'; key: string; label: string } | null;
  notes: { byName: string; at: string; text: string }[];
  decidedByName: string | null;
  decidedAt: string | null;
  createdAt: string | null;
}

const ALREADY = 'Already decided.';

const view = (a: ApprovalDocument | any): ApprovalView => ({
  id: String(a._id),
  case: a.case ? String(a.case) : null,
  type: a.type,
  agent: a.agent,
  summary: a.summary,
  roles: [...a.roles],
  primary: { kind: a.primary.kind, label: a.primary.label },
  source: a.source?.kind ? { kind: a.source.kind, id: a.source.id } : null,
  state: a.state,
  assignedTo: a.assignedTo?.key ? { kind: a.assignedTo.kind, key: a.assignedTo.key, label: a.assignedTo.label } : null,
  notes: (a.notes ?? []).map((n: any) => ({ byName: n.byName, at: new Date(n.at).toISOString(), text: n.text })),
  decidedByName: a.decidedByName ?? null,
  decidedAt: a.decidedAt ? new Date(a.decidedAt).toISOString() : null,
  createdAt: a.createdAt ? new Date(a.createdAt).toISOString() : null,
});

/** Things an agent needs a person to decide. Times are real time. */
@Injectable()
export class ApprovalsService {
  constructor(
    @InjectModel(Approval.name) private readonly model: Model<ApprovalDocument>,
    @InjectModel(DutyTitle.name) private readonly titleModel: Model<DutyTitleDocument>,
    private readonly registry: AgentRegistry,
    private readonly messages: MessagesService,
  ) {}

  async request(input: { type: string; case?: string | null; summary: string; source?: { kind: string; id: string } }): Promise<ApprovalDocument> {
    const def = this.registry.approvalType(input.type);
    if (!def) throw new BadRequestException(`Unknown approval type "${input.type}"`);
    if (input.case && !Types.ObjectId.isValid(input.case)) throw new BadRequestException('"case" is not a valid id');
    const openBySource = () =>
      this.model.findOne({ 'source.kind': input.source!.kind, 'source.id': input.source!.id, state: 'open' }).exec();
    if (input.source) {
      const existing = await openBySource();
      if (existing) return existing;
    }
    let a: ApprovalDocument;
    try {
      a = await this.model.create({
        case: input.case ? new Types.ObjectId(input.case) : null,
        type: def.type,
        agent: def.agent,
        summary: input.summary.slice(0, 140),
        roles: def.roles,
        primary: def.primary,
        ...(input.source ? { source: input.source } : {}),
        state: 'open',
        notes: [],
      });
    } catch (err) {
      // 11000: another pass asked for the same source a moment ago.
      const existing = (err as { code?: number }).code === 11000 && input.source ? await openBySource() : null;
      if (!existing) throw err;
      return existing;
    }
    await this.messages.send({
      case: input.case ?? null,
      from: 'coordinator',
      to: [def.agent],
      type: 'approval.requested',
      priority: 'high',
      summary: `Approval needed: ${input.summary}`.slice(0, 140),
      payload: { approvalType: def.type },
      dedupeKey: `approval.requested:${a._id}`,
    });
    return a;
  }

  private async find(id: string): Promise<ApprovalDocument> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Approval not found');
    const a = await this.model.findById(id).exec();
    if (!a) throw new NotFoundException('Approval not found');
    return a;
  }

  async act(actor: Actor, id: string, decision: 'approved' | 'rejected'): Promise<ApprovalView> {
    if (decision !== 'approved' && decision !== 'rejected') throw new BadRequestException('Decision must be approved or rejected.');
    const a = await this.find(id);
    const def = this.registry.approvalType(a.type);
    if (!actor || !a.roles.includes(actor.role)) throw new ForbiddenException('Your role cannot decide this approval.');
    if (a.primary.kind === 'open') throw new ConflictException('This approval is handled on its own screen.');
    if (a.state !== 'open') throw new ConflictException(ALREADY);
    if (!def) throw new ConflictException('This approval type is no longer available.');
    const claimed = await this.model
      .findOneAndUpdate({ _id: a._id, state: 'open' }, { $set: { state: decision, decidedByName: actor.name, decidedAt: new Date() } }, { new: true })
      .exec();
    if (!claimed) throw new ConflictException(ALREADY);
    try {
      await def.onDecision?.(String(a._id), decision, actor);
    } catch (err) {
      await this.model.updateOne({ _id: a._id }, { $set: { state: 'open' }, $unset: { decidedByName: '', decidedAt: '' } }).exec();
      throw err;
    }
    await this.messages.send({
      case: a.case ? String(a.case) : null,
      from: 'coordinator',
      to: [a.agent],
      type: 'approval.decided',
      priority: 'high',
      summary: `Approval ${decision} by ${actor.name}: ${a.summary}`.slice(0, 140),
      payload: { approvalType: a.type, decision },
      dedupeKey: `approval.decided:${a._id}`,
    });
    return view(claimed);
  }

  /** Changes who is asked (a duty title or a role). Who may act (`roles`) stays as the type set it. */
  async reassign(actor: Actor, id: string, target: { kind: 'title' | 'role'; key: string }, note: string): Promise<ApprovalView> {
    const a = await this.find(id);
    if (!actor || (actor.role !== UserRole.ADMIN && !a.roles.includes(actor.role))) {
      throw new ForbiddenException('Your role cannot reassign this approval.');
    }
    if (a.state !== 'open') throw new ConflictException(ALREADY);
    const text = (note ?? '').trim();
    if (!text) throw new BadRequestException('Add a note saying why.');
    let label: string;
    if (target?.kind === 'title') {
      const title = await this.titleModel.findOne({ key: target.key }).lean().exec();
      if (!title) throw new BadRequestException(`Unknown duty title "${target.key}".`);
      label = title.label;
    } else if (target?.kind === 'role') {
      if (!Object.values(UserRole).includes(target.key as UserRole)) throw new BadRequestException(`Unknown role "${target.key}".`);
      label = target.key.charAt(0).toUpperCase() + target.key.slice(1);
    } else {
      throw new BadRequestException('Choose a duty title or a role.');
    }
    const updated = await this.model
      .findOneAndUpdate(
        { _id: a._id, state: 'open' },
        { $set: { assignedTo: { kind: target.kind, key: target.key, label } }, $push: { notes: { byName: actor.name, at: new Date(), text } } },
        { new: true },
      )
      .exec();
    if (!updated) throw new ConflictException(ALREADY);
    return view(updated);
  }

  /** The owning agent decided on its own screen: close the open approval for that source. */
  async markDone(source: { kind: string; id: string }, byName: string): Promise<ApprovalDocument | null> {
    return this.model
      .findOneAndUpdate(
        { 'source.kind': source.kind, 'source.id': source.id, state: 'open' },
        { $set: { state: 'done', decidedByName: byName, decidedAt: new Date() } },
        { new: true },
      )
      .exec();
  }

  async list(q: { state?: string; limit?: number } = {}): Promise<ApprovalView[]> {
    const limit = Math.min(Math.max(Math.floor(Number(q.limit)) || 50, 1), 200);
    const filter = q.state ? { state: q.state } : {};
    const rows = await this.model.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit).lean().exec();
    return rows.map(view);
  }

  countOpen(): Promise<number> {
    return this.model.countDocuments({ state: 'open' }).exec();
  }
}
