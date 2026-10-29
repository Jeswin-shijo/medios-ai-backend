import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CoordinatorEvents } from './coordinator-events';
import { AgentKey, AgentMessageInput, Priority, validatePayload } from './coordinator-types';
import { AgentRegistry } from './agent-registry';
import { AgentMessage, MessageDocument } from './schemas/agent-message.schema';

export const DELIVERY_TRIES = 3;
export const HOP_LIMIT = 10;
export const DUPLICATE_WINDOW_MS = 60_000;
export const LOCK_MS = 60_000;
export const REDELIVER_AFTER_MS = 10_000;

export type MessageProblem = { kind: 'failed' | 'loop'; type: string; case: string | null; reason: string };
type StoredListener = (m: MessageDocument) => Promise<void>;
type ProblemListener = (p: MessageProblem) => Promise<void>;

export interface MessageView {
  id: string;
  case: string | null;
  from: AgentKey;
  to: AgentKey[];
  type: string;
  priority: Priority;
  summary: string;
  payload: Record<string, unknown>;
  dueBy: string | null;
  needsPerson: boolean;
  opensWork: boolean;
  resolves: string | null;
  causedBy: string | null;
  hop: number;
  state: 'pending' | 'delivered' | 'failed';
  attempts: number;
  resolvedAt: string | null;
  createdAt: string;
}

export interface MessageQuery {
  case?: string;
  type?: string;
  agent?: AgentKey;
  openWork?: boolean;
  limit?: number;
  before?: string;
}

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);
const idOrNull = (v: unknown) => (v ? String(v) : null);

function toView(m: any): MessageView {
  return {
    id: String(m._id),
    case: idOrNull(m.case),
    from: m.from,
    to: m.to ?? [],
    type: m.type,
    priority: m.priority,
    summary: m.summary,
    payload: m.payload ?? {},
    dueBy: iso(m.dueBy),
    needsPerson: !!m.needsPerson,
    opensWork: !!m.opensWork,
    resolves: idOrNull(m.resolves),
    causedBy: idOrNull(m.causedBy),
    hop: m.hop ?? 0,
    state: m.state,
    attempts: m.attempts ?? 0,
    resolvedAt: iso(m.resolvedAt),
    createdAt: iso(m.createdAt) as string,
  };
}

/** Store-then-deliver message bus between the agents. Uses real time, not the clinic clock. */
@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);
  private readonly storedListeners: StoredListener[] = [];
  private readonly problemListeners: ProblemListener[] = [];

  constructor(
    @InjectModel(AgentMessage.name) private readonly model: Model<MessageDocument>,
    private readonly registry: AgentRegistry,
    private readonly events: CoordinatorEvents,
  ) {}

  onStored(listener: StoredListener): void {
    this.storedListeners.push(listener);
  }

  onProblem(listener: ProblemListener): void {
    this.problemListeners.push(listener);
  }

  private async report(p: MessageProblem): Promise<void> {
    for (const l of this.problemListeners) {
      try {
        await l(p);
      } catch (e) {
        this.logger.error(`Problem listener failed: ${(e as Error).message}`);
      }
    }
  }

  async send(input: AgentMessageInput): Promise<MessageDocument | null> {
    const def = this.registry.messageType(input.type);
    if (!def) throw new BadRequestException(`Unknown message type "${input.type}"`);
    const errors = validatePayload(def, input.payload);
    if (errors.length) throw new BadRequestException(errors.join('; '));

    const caseId = input.case ?? null;
    for (const [name, value] of [['case', caseId], ['causedBy', input.causedBy], ['resolves', input.resolves]] as const) {
      if (value && !Types.ObjectId.isValid(value)) throw new BadRequestException(`"${name}" is not a valid id`);
    }
    let hop = 0;
    if (input.causedBy) {
      const parent = await this.model.findById(input.causedBy).select('hop').lean().exec();
      if (!parent) throw new BadRequestException('"causedBy" matches no message');
      hop = (parent.hop ?? 0) + 1;
    }
    if (input.resolves && !(await this.model.exists({ _id: input.resolves }).exec())) {
      throw new BadRequestException('"resolves" matches no message');
    }
    if (hop > HOP_LIMIT) {
      await this.report({ kind: 'loop', type: input.type, case: caseId, reason: `Chain went past ${HOP_LIMIT} hops` });
      return null;
    }

    const dedupeKey =
      input.dedupeKey ?? `${input.type}:${caseId}:${createHash('sha1').update(JSON.stringify(input.payload ?? {})).digest('hex')}`;
    const recent = await this.model
      .exists({ dedupeKey, createdAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) } })
      .exec();
    if (recent) return null;

    const message = await this.model.create({
      case: caseId ? new Types.ObjectId(caseId) : null,
      from: input.from,
      to: input.to,
      type: input.type,
      priority: input.priority,
      summary: input.summary,
      payload: input.payload ?? {},
      dueBy: input.dueBy ?? null,
      needsPerson: input.needsPerson ?? false,
      opensWork: input.opensWork ?? false,
      resolves: input.resolves ? new Types.ObjectId(input.resolves) : undefined,
      causedBy: input.causedBy ? new Types.ObjectId(input.causedBy) : undefined,
      hop,
      dedupeKey,
      state: 'pending',
      attempts: 0,
    });

    if (input.resolves) {
      await this.model.updateOne({ _id: input.resolves, resolvedAt: { $exists: false } }, { $set: { resolvedAt: new Date(), resolvedBy: message._id } }).exec();
    }
    for (const l of this.storedListeners) {
      try {
        await l(message);
      } catch (e) {
        this.logger.error(`Stored listener failed: ${(e as Error).message}`);
      }
    }
    this.events.emit({
      kind: 'message',
      id: String(message._id),
      caseId: caseId ?? undefined,
      from: message.from,
      to: message.to,
      summary: message.summary,
    });
    await this.deliver(String(message._id));
    return (await this.model.findById(message._id).exec()) ?? message;
  }

  /** Claims the message with a lock, then calls the handlers; a failed handler is retried at once. */
  private async deliver(id: string): Promise<boolean> {
    const now = new Date();
    const claimed = await this.model
      .findOneAndUpdate(
        { _id: id, state: 'pending', $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: null }, { lockedUntil: { $lt: now } }] },
        { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } },
        { new: true },
      )
      .exec();
    if (!claimed) return false;

    try {
      const done = new Set<number>();
      const subscribers = this.registry.subscribers(claimed.type);
      let attempts = claimed.attempts;
      let lastError = '';
      while (attempts < DELIVERY_TRIES) {
        for (let i = 0; i < subscribers.length; i++) {
          if (done.has(i)) continue;
          try {
            await subscribers[i].handler(id);
            done.add(i);
          } catch (e) {
            lastError = `${subscribers[i].agent}: ${(e as Error).message}`;
          }
        }
        if (done.size === subscribers.length) {
          await this.model.updateOne({ _id: id }, { $set: { state: 'delivered', attempts }, $unset: { lockedUntil: 1 } }).exec();
          return true;
        }
        attempts += 1;
        await this.model.updateOne({ _id: id }, { $set: { attempts } }).exec();
      }
      await this.model.updateOne({ _id: id }, { $set: { state: 'failed' }, $unset: { lockedUntil: 1 } }).exec();
      await this.report({
        kind: 'failed',
        type: claimed.type,
        case: idOrNull(claimed.case),
        reason: `Not delivered after ${DELIVERY_TRIES} tries (${lastError})`,
      });
      return false;
    } finally {
      // A DB error mid-delivery must not leave the lock set; the message stays pending for redelivery.
      await this.model.updateOne({ _id: id }, { $unset: { lockedUntil: 1 } }).exec().catch(() => undefined);
    }
  }

  /** Delivers pending messages that are unlocked or whose lock ran out. Returns how many were delivered. */
  async redeliverPending(): Promise<number> {
    const now = new Date();
    // Skip messages stored a moment ago: send() may still be running its listeners for them.
    const pending = await this.model
      .find({ state: 'pending', createdAt: { $lt: new Date(now.getTime() - REDELIVER_AFTER_MS) }, $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: null }, { lockedUntil: { $lt: now } }] })
      .select('_id')
      .sort({ createdAt: 1 })
      .lean()
      .exec();
    let count = 0;
    for (const p of pending) {
      if (await this.deliver(String(p._id))) count += 1;
    }
    return count;
  }

  async list(q: MessageQuery = {}): Promise<MessageView[]> {
    const match: Record<string, unknown> = {};
    if (q.case && !Types.ObjectId.isValid(q.case)) throw new BadRequestException('"case" is not a valid id');
    if (q.case) match.case = new Types.ObjectId(q.case);
    if (q.type) match.type = q.type;
    if (q.agent) match.$or = [{ from: q.agent }, { to: q.agent }];
    if (q.openWork) {
      match.opensWork = true;
      match.$and = [{ $or: [{ resolvedAt: { $exists: false } }, { resolvedAt: null }] }];
    }
    if (q.before) {
      let at: Date | null = null;
      if (/^[a-f\d]{24}$/i.test(q.before)) {
        const ref = await this.model.findById(q.before).select('createdAt').lean().exec();
        at = ref?.createdAt ?? null;
      } else if (!isNaN(Date.parse(q.before))) {
        at = new Date(q.before);
      }
      if (!at) throw new BadRequestException('"before" must be a message id or an ISO time');
      match.createdAt = { $lt: at };
    }
    const rows = await this.model
      .aggregate([
        { $match: match },
        {
          $addFields: {
            rank: {
              $switch: {
                branches: [
                  { case: { $eq: ['$priority', 'critical'] }, then: 0 },
                  { case: { $eq: ['$priority', 'high'] }, then: 1 },
                  { case: { $eq: ['$priority', 'medium'] }, then: 2 },
                ],
                default: 3,
              },
            },
          },
        },
        { $sort: { rank: 1, createdAt: -1, _id: -1 } },
        { $limit: Math.min(Math.max(q.limit ?? 50, 1), 500) },
      ])
      .exec();
    return rows.map(toView);
  }

  /** One case's messages, oldest first (the timeline order). */
  async forCase(caseId: string): Promise<MessageView[]> {
    if (!Types.ObjectId.isValid(caseId)) throw new BadRequestException('"case" is not a valid id');
    const rows = await this.model.find({ case: new Types.ObjectId(caseId) }).sort({ createdAt: 1, _id: 1 }).lean().exec();
    return rows.map(toView);
  }

  async get(id: string): Promise<MessageView | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const m = await this.model.findById(id).lean().exec();
    return m ? toView(m) : null;
  }

  countSince(since: Date): Promise<number> {
    return this.model.countDocuments({ createdAt: { $gte: since } }).exec();
  }
}
