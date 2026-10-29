import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClockDef } from './coordinator-types';
import { AgentRegistry } from './agent-registry';
import { EscalationsService } from './escalations.service';
import { MessagesService } from './messages.service';
import { Clock, ClockDocument, ClockState } from './schemas/clock.schema';
import type { MessageDocument } from './schemas/agent-message.schema';

const MINUTE_MS = 60_000;

export interface ClockView {
  id: string;
  def: string;
  case: string | null;
  startedBy: string;
  startedAt: string;
  dueAt: string;
  state: ClockState;
  stoppedAt: string | null;
  metMinutes: number | null;
  escalation: string | null;
}

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);

function toView(c: any): ClockView {
  return {
    id: String(c._id),
    def: c.def,
    case: c.case ? String(c.case) : null,
    startedBy: String(c.startedBy),
    startedAt: iso(c.startedAt) as string,
    dueAt: iso(c.dueAt) as string,
    state: c.state,
    stoppedAt: iso(c.stoppedAt),
    metMinutes: c.metMinutes ?? null,
    escalation: c.escalation ? String(c.escalation) : null,
  };
}

/** Deadline clocks: a start message begins one, a stop message meets it, checkDue expires it. Real time. */
@Injectable()
export class ClocksService implements OnModuleInit {
  private readonly logger = new Logger(ClocksService.name);
  private readonly unknownLogged = new Set<string>();

  constructor(
    @InjectModel(Clock.name) private readonly model: Model<ClockDocument>,
    private readonly registry: AgentRegistry,
    private readonly messages: MessagesService,
    private readonly escalations: EscalationsService,
  ) {
    this.messages.onStored((m) => this.onMessage(m));
  }

  /** Drops the old one-clock-per-case index (def + case) so clocks can be one per item. */
  async onModuleInit(): Promise<void> {
    try {
      const old = (await this.model.collection.indexes()).find((i) => {
        const keys = Object.keys(i.key ?? {});
        return keys.length === 2 && i.key.def === 1 && i.key.case === 1;
      });
      if (old?.name) {
        await this.model.collection.dropIndex(old.name);
        this.logger.log(`Dropped the old clocks index ${old.name}; clocks are now one per case and item`);
      }
    } catch (e) {
      // No collection yet, or the index is already gone: nothing to migrate.
      this.logger.debug(`Clocks index check skipped: ${(e as Error).message}`);
    }
  }

  /** The item a message's clock is for: the definition's ref, or null when it has none or it is unusable. */
  private refFrom(def: ClockDef, type: string, payload: Record<string, unknown>): string | null {
    if (!def.refFrom) return null;
    try {
      const r = def.refFrom(type, payload);
      return typeof r === 'string' ? r : null;
    } catch (e) {
      if (!this.unknownLogged.has(`refFrom:${def.key}`)) {
        this.unknownLogged.add(`refFrom:${def.key}`);
        this.logger.error(`refFrom of clock ${def.key} failed, using no ref: ${(e as Error).message}`);
      }
      return null;
    }
  }

  private async onMessage(m: MessageDocument): Promise<void> {
    const payload = ((m.payload as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
    const accepts = (def: ClockDef) => {
      try {
        return !def.match || def.match(m.type, payload);
      } catch (e) {
        this.logger.error(`Matching clock ${def.key} failed: ${(e as Error).message}`);
        return false;
      }
    };
    for (const def of this.registry.clocksStartingOn(m.type).filter(accepts)) {
      try {
        await this.start(def, m, payload, this.refFrom(def, m.type, payload));
      } catch (e) {
        this.logger.error(`Starting clock ${def.key} failed: ${(e as Error).message}`);
      }
    }
    for (const def of this.registry.clocksStoppingOn(m.type).filter(accepts)) {
      try {
        await this.stop(def.key, m, this.refFrom(def, m.type, payload));
      } catch (e) {
        this.logger.error(`Stopping clock ${def.key} failed: ${(e as Error).message}`);
      }
    }
    for (const def of this.registry.clocksUpdatingOn(m.type).filter(accepts)) {
      try {
        const dueAt = this.dueFrom(def, payload);
        if (!dueAt) continue;
        // Only the running clock for this case and item moves; met and expired ones stay as they are.
        await this.model.updateOne({ def: def.key, case: m.case ?? null, ref: this.refFrom(def, m.type, payload), state: 'running' }, { $set: { dueAt } }).exec();
      } catch (e) {
        this.logger.error(`Moving clock ${def.key} failed: ${(e as Error).message}`);
      }
    }
  }

  /** The due time the definition reads from a payload, or null when it has none or it is unusable. */
  private dueFrom(def: ClockDef, payload: Record<string, unknown>): Date | null {
    if (!def.dueFrom) return null;
    try {
      const d = def.dueFrom(payload);
      return d instanceof Date && !isNaN(d.getTime()) ? d : null;
    } catch (e) {
      if (!this.unknownLogged.has(`dueFrom:${def.key}`)) {
        this.unknownLogged.add(`dueFrom:${def.key}`);
        this.logger.error(`dueFrom of clock ${def.key} failed, using its minutes: ${(e as Error).message}`);
      }
      return null;
    }
  }

  private async start(def: ClockDef, m: MessageDocument, payload: Record<string, unknown>, ref: string | null): Promise<void> {
    const startedAt = m.createdAt ? new Date(m.createdAt) : new Date();
    try {
      await this.model.create({
        def: def.key,
        case: m.case ?? null,
        ref,
        startedBy: m._id,
        startedAt,
        dueAt: this.dueFrom(def, payload) ?? new Date(startedAt.getTime() + def.minutes * MINUTE_MS),
        state: 'running',
      });
    } catch (e) {
      // 11000: the partial unique index says one is already running, so a repeat changes nothing.
      if ((e as { code?: number }).code !== 11000) throw e;
    }
  }

  private async stop(defKey: string, m: MessageDocument, ref: string | null): Promise<void> {
    const at = new Date();
    const key = { def: defKey, case: m.case ?? null, ref };
    const metOf = (c: { startedAt: Date }) => Math.round((at.getTime() - new Date(c.startedAt).getTime()) / MINUTE_MS);
    const running = await this.model.findOne({ ...key, state: 'running' }).exec();
    if (running) {
      const met = await this.model
        .findOneAndUpdate({ _id: running._id, state: 'running' }, { $set: { state: 'met', stoppedAt: at, metMinutes: metOf(running) } })
        .exec();
      if (met) return;
    }
    // Already expired: record when it was finally met, but leave the state and its escalation alone.
    const expired = await this.model.findOne({ ...key, state: 'expired', stoppedAt: { $exists: false } }).sort({ startedAt: -1 }).exec();
    if (expired) {
      await this.model.updateOne({ _id: expired._id, stoppedAt: { $exists: false } }, { $set: { stoppedAt: at, metMinutes: metOf(expired) } }).exec();
    }
  }

  /**
   * Expires running clocks past their time, sends clock.expired and raises each ladder. Also finishes
   * clocks a crashed pass left expired with no escalation. Returns how many expired.
   */
  async checkDue(now: Date): Promise<number> {
    const due = await this.model.find({ state: 'running', dueAt: { $lte: now } }).sort({ dueAt: 1 }).exec();
    let expired = 0;
    for (const c of due) {
      try {
        const def = this.registry.clock(c.def);
        if (!def) {
          this.warnUnknown(c.def);
          continue;
        }
        // The state in the filter stops two overlapping passes from expiring the same clock twice.
        const claimed = await this.model.findOneAndUpdate({ _id: c._id, state: 'running' }, { $set: { state: 'expired' } }, { new: true }).exec();
        if (!claimed) continue;
        expired += 1;
        // The escalation matters more than the notice: a failed send must not stop it.
        await this.messages
          .send({
            case: claimed.case ? String(claimed.case) : null,
            from: 'coordinator',
            to: ['coordinator'],
            type: 'clock.expired',
            priority: 'high',
            summary: `${def.label} overdue`.slice(0, 140),
            payload: { clockKey: def.key },
            causedBy: String(claimed.startedBy),
            dedupeKey: `clock.expired:${claimed._id}`,
          })
          .catch((e) => this.logger.error(`Sending clock.expired for ${String(claimed._id)} failed: ${(e as Error).message}`));
        await this.escalate(claimed);
      } catch (e) {
        this.logger.error(`Expiring clock ${String(c._id)} failed: ${(e as Error).message}`);
      }
    }
    // Expired but never escalated: the API stopped, or the raise failed, after the clock was claimed.
    const orphans = await this.model.find({ state: 'expired', escalation: { $exists: false } }).exec();
    for (const c of orphans) {
      try {
        await this.escalate(c);
      } catch (e) {
        this.logger.error(`Escalating clock ${String(c._id)} failed: ${(e as Error).message}`);
      }
    }
    return expired;
  }

  private warnUnknown(defKey: string): void {
    if (this.unknownLogged.has(defKey)) return;
    this.unknownLogged.add(defKey);
    this.logger.warn(`Clock "${defKey}" is overdue but its definition is not registered; leaving it as it is`);
  }

  /** Raises the definition's ladder for an expired clock (once per clock) and stores the escalation id. */
  private async escalate(c: ClockDocument): Promise<void> {
    const def = this.registry.clock(c.def);
    if (!def) return this.warnUnknown(c.def);
    const esc = await this.escalations.raise({
      ladder: def.ladder,
      case: c.case ? String(c.case) : null,
      reason: `${def.label} overdue`,
      source: { kind: 'clock', id: String(c._id) },
    });
    await this.model.updateOne({ _id: c._id }, { $set: { escalation: esc._id } }).exec();
  }

  async list(q: { state?: string; case?: string; limit?: number } = {}): Promise<ClockView[]> {
    const match: Record<string, unknown> = {};
    if (q.case && !Types.ObjectId.isValid(q.case)) throw new BadRequestException('"case" is not a valid id');
    if (q.case) match.case = new Types.ObjectId(q.case);
    if (q.state) match.state = q.state;
    const rows = await this.model
      .find(match)
      .sort({ startedAt: -1, _id: -1 })
      .limit(Math.min(Math.max(q.limit ?? 50, 1), 500))
      .lean()
      .exec();
    return rows.map(toView);
  }

  countRunning(): Promise<number> {
    return this.model.countDocuments({ state: 'running' }).exec();
  }
}
