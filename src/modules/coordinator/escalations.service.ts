import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Actor } from '../beds/actor';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { User, UserDocument, UserRole } from '../users/schemas/user.schema';
import type { DutySource } from './coordinator-types';
import { CoordinatorEvents } from './coordinator-events';
import { MessagesService } from './messages.service';
import { DutyTitle, DutyTitleDocument } from './schemas/duty-title.schema';
import { Escalation, EscalationDocument } from './schemas/escalation.schema';
import { Ladder, LadderDocument, LadderStep } from './schemas/ladder.schema';

const MINUTE_MS = 60_000;

export const DEFAULT_TITLES: { key: string; label: string }[] = [
  { key: 'er-nurse-in-charge', label: 'ER nurse in charge' },
  { key: 'er-consultant', label: 'ER consultant' },
  { key: 'medical-superintendent', label: 'Medical superintendent' },
  { key: 'duty-administrator', label: 'Duty administrator' },
  { key: 'cardiology-on-call', label: 'Cardiology on-call' },
  { key: 'pharmacist-on-duty', label: 'Pharmacist on duty' },
  { key: 'lab-in-charge', label: 'Lab in charge' },
  { key: 'duty-doctor', label: 'Duty doctor' },
  { key: 'chief-pharmacist', label: 'Chief pharmacist' },
  { key: 'ot-in-charge', label: 'OT and cath lab in charge' },
  { key: 'patient-relations', label: 'Patient relations officer' },
  { key: 'billing-in-charge', label: 'Billing in charge' },
  { key: 'ward-nurse-in-charge', label: 'Ward nurse in charge' },
];

export const DEFAULT_LADDERS: { key: string; label: string; steps: LadderStep[] }[] = [
  {
    key: 'default',
    label: 'Default',
    steps: [{ title: 'duty-administrator', waitMinutes: 15 }, { title: 'medical-superintendent', waitMinutes: 0 }],
  },
  {
    key: 'bed-wait',
    label: 'Bed wait',
    steps: [{ title: 'duty-administrator', waitMinutes: 15 }, { title: 'medical-superintendent', waitMinutes: 0 }],
  },
  {
    key: 'er',
    label: 'ER',
    steps: [
      { title: 'er-nurse-in-charge', waitMinutes: 10 },
      { title: 'er-consultant', waitMinutes: 15 },
      { title: 'medical-superintendent', waitMinutes: 0 },
    ],
  },
  {
    key: 'lab',
    label: 'Lab',
    steps: [
      { title: 'lab-in-charge', waitMinutes: 15 },
      { title: 'duty-administrator', waitMinutes: 15 },
      { title: 'medical-superintendent', waitMinutes: 0 },
    ],
  },
  {
    key: 'lab-critical',
    label: 'Lab critical',
    steps: [{ title: 'duty-doctor', waitMinutes: 10 }, { title: 'medical-superintendent', waitMinutes: 0 }],
  },
  {
    key: 'pharmacy',
    label: 'Pharmacy',
    steps: [
      { title: 'pharmacist-on-duty', waitMinutes: 15 },
      { title: 'chief-pharmacist', waitMinutes: 15 },
      { title: 'medical-superintendent', waitMinutes: 0 },
    ],
  },
  {
    key: 'pharmacy-query',
    label: 'Pharmacy query',
    steps: [{ title: 'duty-doctor', waitMinutes: 10 }, { title: 'medical-superintendent', waitMinutes: 0 }],
  },
  { key: 'consult', label: 'Consult', steps: [{ title: 'medical-superintendent', waitMinutes: 0 }] },
  {
    key: 'revenue',
    label: 'Revenue',
    steps: [
      { title: 'billing-in-charge', waitMinutes: 30 },
      { title: 'duty-administrator', waitMinutes: 30 },
      { title: 'medical-superintendent', waitMinutes: 0 },
    ],
  },
  {
    key: 'discharge',
    label: 'Discharge',
    steps: [
      { title: 'ward-nurse-in-charge', waitMinutes: 30 },
      { title: 'duty-administrator', waitMinutes: 30 },
      { title: 'medical-superintendent', waitMinutes: 0 },
    ],
  },
  {
    key: 'discharge-doctor',
    label: 'Discharge doctor',
    steps: [{ title: 'duty-doctor', waitMinutes: 15 }, { title: 'medical-superintendent', waitMinutes: 0 }],
  },
  {
    key: 'patient-support',
    label: 'Patient Support',
    steps: [
      { title: 'patient-relations', waitMinutes: 30 },
      { title: 'duty-administrator', waitMinutes: 30 },
      { title: 'medical-superintendent', waitMinutes: 0 },
    ],
  },
  {
    key: 'support-billing',
    label: 'Patient Support: billing',
    steps: [
      { title: 'billing-in-charge', waitMinutes: 30 },
      { title: 'patient-relations', waitMinutes: 30 },
      { title: 'duty-administrator', waitMinutes: 30 },
      { title: 'medical-superintendent', waitMinutes: 0 },
    ],
  },
  {
    key: 'support-ward',
    label: 'Patient Support: ward',
    steps: [
      { title: 'ward-nurse-in-charge', waitMinutes: 30 },
      { title: 'patient-relations', waitMinutes: 30 },
      { title: 'duty-administrator', waitMinutes: 30 },
      { title: 'medical-superintendent', waitMinutes: 0 },
    ],
  },
  {
    key: 'support-clinical',
    label: 'Patient Support: clinical',
    steps: [{ title: 'duty-doctor', waitMinutes: 15 }, { title: 'medical-superintendent', waitMinutes: 0 }],
  },
];

export interface DutyTitleView {
  key: string;
  label: string;
  holders: string[];
  /** Names of the active holders, in the order of `holders`. Inactive or unknown ids are left out. */
  holderNames: string[];
}
export interface LadderView {
  key: string;
  label: string;
  steps: LadderStep[];
}

export const NO_HOLDERS = 'Admins (no one holds this title yet)';

/** Duty titles, ladders and the escalations that walk them. Uses real time, not the clinic clock. */
@Injectable()
export class EscalationsService {
  private readonly logger = new Logger(EscalationsService.name);
  private dutySource: DutySource | null = null;

  constructor(
    @InjectModel(Escalation.name) private readonly model: Model<EscalationDocument>,
    @InjectModel(DutyTitle.name) private readonly titleModel: Model<DutyTitleDocument>,
    @InjectModel(Ladder.name) private readonly ladderModel: Model<LadderDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alertModel: Model<TaskAlertDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly messages: MessagesService,
    private readonly events: CoordinatorEvents,
  ) {
    this.messages.onProblem(async (p) => {
      await this.raise({
        ladder: 'default',
        case: p.case,
        // p.reason never carries a handler's own error text: that stays in the server log.
        reason: `${p.kind === 'failed' ? 'Agent error' : 'Agent loop'}: ${p.reason}`,
        source: { kind: p.kind },
      });
    });
  }

  /** Adds the default titles and ladders that are missing; never overwrites an admin's edits. */
  async ensureDefaults(): Promise<void> {
    for (const t of DEFAULT_TITLES) {
      await this.titleModel.updateOne({ key: t.key }, { $setOnInsert: { key: t.key, label: t.label, holders: [] } }, { upsert: true }).exec();
    }
    for (const l of DEFAULT_LADDERS) {
      await this.ladderModel.updateOne({ key: l.key }, { $setOnInsert: { key: l.key, label: l.label, steps: l.steps } }, { upsert: true }).exec();
    }
  }

  private async activeUsers(ids: unknown[]): Promise<{ id: string; name: string }[]> {
    if (!ids.length) return [];
    const users = await this.userModel
      .find({ _id: { $in: ids }, isActive: { $ne: false } })
      .select('name')
      .sort({ name: 1 })
      .lean()
      .exec();
    return users.map((u) => ({ id: String(u._id), name: u.name }));
  }

  /** Lets the duty roster decide who holds a title right now. One source; a later call replaces it. */
  useDutySource(source: DutySource): void {
    this.dutySource = source;
  }

  /** Active people holding a title now: the roster's people when it names any, else the fixed holders. Empty when neither does. */
  private async currentHolders(titleKey: string): Promise<{ id: string; name: string }[]> {
    if (this.dutySource) {
      let rostered: string[] | null = null;
      try {
        rostered = await this.dutySource(titleKey, new Date());
      } catch (err) {
        this.logger.warn(`The duty roster failed for "${titleKey}"; using the fixed holders: ${(err as Error).message}`);
      }
      if (rostered?.length) {
        const people = await this.activeUsers(rostered.filter((id) => Types.ObjectId.isValid(id)));
        if (people.length) return people;
      }
    }
    const title = await this.titleModel.findOne({ key: titleKey }).lean().exec();
    return this.activeUsers(title?.holders ?? []);
  }

  /** The people holding a title; every admin when it has none. */
  async holders(titleKey: string): Promise<{ ids: string[]; names: string[] }> {
    let people = await this.currentHolders(titleKey);
    if (!people.length) {
      const admins = await this.userModel.find({ role: UserRole.ADMIN, isActive: { $ne: false } }).select('name').sort({ name: 1 }).lean().exec();
      people = admins.map((u) => ({ id: String(u._id), name: u.name }));
    }
    return { ids: people.map((p) => p.id), names: people.map((p) => p.name) };
  }

  private async stepView(titleKey: string) {
    const [title, who, current] = await Promise.all([this.titleModel.findOne({ key: titleKey }).lean().exec(), this.holders(titleKey), this.currentHolders(titleKey)]);
    const label = title?.label ?? titleKey;
    return { label, names: who.names, subtitle: current.length > 0 ? `On duty: ${who.names.join(', ')}` : NO_HOLDERS };
  }

  /**
   * Writes the escalation's alert. With an `alertLink` the escalation takes over the alert already kept for
   * that link (one alert per link), or makes it; later steps rewrite the alert it stored.
   */
  private async writeAlert(e: EscalationDocument, titleKey: string, create: boolean, alertLink?: string) {
    const v = await this.stepView(titleKey);
    const fields = {
      title: `Escalated to ${v.label}: ${e.reason}`,
      subtitle: v.subtitle,
      escalation: { id: String(e._id), ladder: e.ladder, step: e.step, titleKey, titleLabel: v.label, holderNames: v.names },
    };
    const link = alertLink ?? `escalation:${e._id}`;
    // A step up reclaims the alert only while it still belongs to this escalation (a newer query may have reused it).
    const filter = create || !alertLink || !e.alert ? { link } : { _id: e.alert, 'escalation.id': String(e._id) };
    const alert = await this.alertModel
      .findOneAndUpdate(
        filter,
        create
          ? { $set: fields, $setOnInsert: { type: 'System', category: 'Critical', priority: 'High', status: 'Pending', link } }
          : { $set: fields },
        { upsert: create, new: true },
      )
      .exec();
    return { alert, label: v.label };
  }

  async raise(input: {
    ladder: string;
    case?: string | null;
    reason: string;
    source: Escalation['source'];
    /** The alert link to use instead of `escalation:<id>`, e.g. `lab-line:<id>`. */
    alertLink?: string;
    /** Closed only by its source's work being done (see resolve), never by Acknowledge. */
    closesOnStop?: boolean;
  }): Promise<EscalationDocument> {
    const ladder = await this.ladderModel.findOne({ key: input.ladder }).lean().exec();
    if (!ladder || !ladder.steps.length) throw new BadRequestException(`Unknown ladder "${input.ladder}"`);
    const bySource = () => this.model.findOne({ 'source.kind': input.source.kind, 'source.id': input.source.id }).exec();
    if (input.source.id) {
      const existing = await bySource();
      if (existing) return existing;
    }
    const now = new Date();
    let e: EscalationDocument;
    try {
      e = await this.model.create({
        case: input.case ? new Types.ObjectId(input.case) : null,
        ladder: input.ladder,
        step: 0,
        reason: input.reason,
        source: input.source,
        state: 'open',
        raisedAt: now,
        stepAt: now,
        ...(input.closesOnStop ? { closesOnStop: true } : {}),
        ...(input.alertLink ? { alertLink: input.alertLink } : {}),
      });
    } catch (err) {
      // 11000: another pass raised it for the same source a moment ago.
      const existing = (err as { code?: number }).code === 11000 && input.source.id ? await bySource() : null;
      if (!existing) throw err;
      return existing;
    }
    const { alert, label } = await this.writeAlert(e, ladder.steps[0].title, true, input.alertLink);
    e.alert = alert!._id as Types.ObjectId;
    await e.save();
    await this.messages.send({
      case: input.case ?? null,
      from: 'coordinator',
      to: ['coordinator'],
      type: 'escalation.raised',
      priority: 'high',
      summary: `Escalated to ${label}: ${input.reason}`.slice(0, 140),
      payload: { reason: input.reason },
      dedupeKey: `escalation.raised:${e._id}`,
    });
    return e;
  }

  /** Moves open escalations whose wait has passed to the next step. Returns how many moved. One failure never stops the rest. */
  async advanceDue(now: Date): Promise<number> {
    const open = await this.model.find({ state: 'open' }).exec();
    let moved = 0;
    for (const e of open) {
      try {
        if (await this.advanceOne(e, now)) moved += 1;
      } catch (err) {
        this.logger.error(`Moving escalation ${String(e._id)} up its ladder failed: ${(err as Error).message}`);
      }
    }
    return moved;
  }

  private async advanceOne(e: EscalationDocument, now: Date): Promise<boolean> {
    const ladder = await this.ladderModel.findOne({ key: e.ladder }).lean().exec();
    if (!ladder || e.step >= ladder.steps.length - 1) return false;
    const wait = Math.max(0, ladder.steps[e.step].waitMinutes) * MINUTE_MS;
    if (new Date(e.stepAt).getTime() + wait > now.getTime()) return false;
    const next = e.step + 1;
    // The step in the filter stops two passes from moving the same escalation twice.
    const updated = await this.model.findOneAndUpdate({ _id: e._id, state: 'open', step: e.step }, { $set: { step: next, stepAt: now } }, { new: true }).exec();
    if (!updated) return false;
    await this.writeAlert(updated, ladder.steps[next].title, false, updated.alertLink);
    this.emit(updated);
    return true;
  }

  private emit(e: EscalationDocument): void {
    this.events.emit({ kind: 'escalation', id: String(e._id), ...(e.case ? { caseId: String(e.case) } : {}) });
  }

  async acknowledge(actor: Actor, id: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Escalation not found');
    const e = await this.model.findById(id).exec();
    if (!e) throw new NotFoundException('Escalation not found');
    if (e.state === 'acknowledged') throw new ConflictException('Already acknowledged.');
    if (e.alertLink?.startsWith('scheduling-consult:')) throw new ConflictException('Mark the consult seen on the Scheduling page.');
    if (e.closesOnStop) {
      throw new ConflictException(
        e.alertLink?.startsWith('pharmacy-line:')
          ? 'Answer the query on the Pharmacy Agent page; this alert closes when it is answered.'
          : e.alertLink?.startsWith('revenue-')
            ? 'Finish it on the Revenue page.'
            : e.alertLink?.startsWith('discharge-')
              ? 'This closes on the Discharge page.'
              : e.alertLink?.startsWith('support-')
                ? 'This closes on the Patient Support page.'
                : 'Acknowledge the result on the Lab page; this alert closes when it is acknowledged.',
      );
    }
    if (actor.role !== UserRole.ADMIN) {
      const ladder = await this.ladderModel.findOne({ key: e.ladder }).lean().exec();
      const keys = (ladder?.steps ?? []).slice(e.step).map((s) => s.title);
      let allowed = false;
      for (const key of keys) {
        if ((await this.currentHolders(key)).some((p) => p.id === actor.id)) {
          allowed = true;
          break;
        }
      }
      if (!allowed) throw new ForbiddenException('Only the person on duty for this step, someone further up, or an admin can acknowledge.');
    }
    const done = await this.model
      .findOneAndUpdate(
        { _id: e._id, state: 'open' },
        { $set: { state: 'acknowledged', ackBy: actor.id, ackByName: actor.name, ackAt: new Date() } },
        { new: true },
      )
      .exec();
    if (!done) throw new ConflictException('Already acknowledged.');
    await this.alertModel.updateOne({ _id: e.alert }, { $set: { status: 'Completed' } }).exec();
    this.emit(done);
  }

  /** Closes an open escalation because its source's work is done (no person acknowledged it here), and completes its alert. */
  async resolve(id: string, by: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) return;
    const done = await this.model
      .findOneAndUpdate({ _id: id, state: 'open' }, { $set: { state: 'acknowledged', ackByName: by, ackAt: new Date() } }, { new: true })
      .exec();
    if (!done) return;
    // Only while the alert still belongs to this escalation: a later query may have reused the alert.
    if (done.alert) await this.alertModel.updateOne({ _id: done.alert, 'escalation.id': String(done._id) }, { $set: { status: 'Completed' } }).exec();
    this.emit(done);
  }

  async titles(): Promise<DutyTitleView[]> {
    const list = await this.titleModel.find().lean().exec();
    const order = new Map(DEFAULT_TITLES.map((t, i) => [t.key, i]));
    const names = await this.activeNames(list.flatMap((t) => t.holders));
    return list
      .sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99) || a.label.localeCompare(b.label))
      .map((t) => ({
        key: t.key,
        label: t.label,
        holders: t.holders.map(String),
        holderNames: t.holders.map((h) => names.get(String(h))).filter((n): n is string => !!n),
      }));
  }

  /** One query: id to name for the active users among these ids. */
  private async activeNames(ids: unknown[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const users = await this.userModel.find({ _id: { $in: ids }, isActive: { $ne: false } }).select('name').lean().exec();
    return new Map(users.map((u) => [String(u._id), u.name]));
  }

  private requireAdmin(actor: Actor): void {
    if (actor.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can change duty titles and ladders.');
  }

  async saveTitle(actor: Actor, title: { key: string; label: string; holders: string[] }): Promise<DutyTitleView> {
    this.requireAdmin(actor);
    const key = (title.key ?? '').trim();
    const label = (title.label ?? '').trim();
    if (!key || !label) throw new BadRequestException('A duty title needs a key and a label.');
    const holders = [...new Set(title.holders ?? [])];
    if (holders.some((h) => !Types.ObjectId.isValid(h)) || (await this.userModel.countDocuments({ _id: { $in: holders } }).exec()) !== holders.length) {
      throw new BadRequestException('Every holder must be an existing user.');
    }
    await this.titleModel.updateOne({ key }, { $set: { label, holders: holders.map((h) => new Types.ObjectId(h)) } }, { upsert: true }).exec();
    const names = await this.activeNames(holders);
    return { key, label, holders, holderNames: holders.map((h) => names.get(h)).filter((n): n is string => !!n) };
  }

  async ladders(): Promise<LadderView[]> {
    const list = await this.ladderModel.find().sort({ key: 1 }).lean().exec();
    return list.map((l) => ({ key: l.key, label: l.label, steps: l.steps.map((s) => ({ title: s.title, waitMinutes: s.waitMinutes })) }));
  }

  async saveLadder(actor: Actor, ladder: { key: string; label: string; steps: LadderStep[] }): Promise<LadderView> {
    this.requireAdmin(actor);
    const key = (ladder.key ?? '').trim();
    const label = (ladder.label ?? '').trim();
    const steps = ladder.steps ?? [];
    if (!key || !label) throw new BadRequestException('A ladder needs a key and a label.');
    if (!steps.length) throw new BadRequestException('A ladder needs at least one step.');
    const known = new Set((await this.titleModel.find().select('key').lean().exec()).map((t) => t.key));
    steps.forEach((s, i) => {
      if (!known.has(s.title)) throw new BadRequestException(`Step ${i + 1} names an unknown duty title "${s.title}".`);
      if (i < steps.length - 1 && !(Number(s.waitMinutes) >= 1)) throw new BadRequestException(`Step ${i + 1} must wait at least 1 minute.`);
    });
    const clean = steps.map((s, i) => ({ title: s.title, waitMinutes: i < steps.length - 1 ? Number(s.waitMinutes) : Math.max(0, Number(s.waitMinutes) || 0) }));
    await this.ladderModel.updateOne({ key }, { $set: { label, steps: clean } }, { upsert: true }).exec();
    return { key, label, steps: clean };
  }
}
