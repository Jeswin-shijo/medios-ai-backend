import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { CasesService } from '../coordinator/cases.service';
import { MessagesService } from '../coordinator/messages.service';
import { CoordinatorCounter, CoordinatorCounterDocument } from '../coordinator/schemas/coordinator-counter.schema';
import { PatientsService } from '../patients/patients.service';
import {
  DOSES_PER_DAY,
  Frequency,
  Priority,
  ProductDef,
  medicineByKey,
  productByKey,
  quantityFor,
} from './pharmacy-catalogue';
import { PatientFactsView, PharmacyPatientsService } from './pharmacy-patients.service';
import { CASE_PRIORITY, ClockState, LineEvent, PharmacyRounds, startKey } from './pharmacy-rounds';
import { CheckLine, Flag, FlagDraft, FlagKind, checkLine, mergeFlags, needsDoctor, newRed } from './pharmacy-rules';
import { PharmacySettingsService } from './pharmacy-settings.service';
import { PharmacyLine, PharmacyLineDocument, PharmacyLineStatus } from './schemas/pharmacy-line.schema';
import { PharmacyLocation, PharmacyLocationDocument } from './schemas/pharmacy-location.schema';
import { PHARMACY_PRIORITIES, PharmacyOrder, PharmacyOrderDocument, PharmacySetting } from './schemas/pharmacy-order.schema';

export type { ClockState, LineEvent, LineMessageType } from './pharmacy-rounds';
export * from './pharmacy-views';
import { FlagView, PharmacyLineView, PharmacyOrderView, buildLineViews, buildOrderViews, flagView } from './pharmacy-views';

type By = { id: string; name: string };

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const MAX_LINES = 10;
const WORKLIST_LIMIT = 300;
/** A line issued within this long (real time) still counts as active for the checks. */
export const ACTIVE_ISSUED_MS = DAY_MS;
const PRIORITY_RANK: Record<Priority, number> = { stat: 0, urgent: 1, routine: 2 };

export interface LineInput {
  medicine: string;
  product: string;
  dose: number;
  route: string;
  frequency: string;
  durationDays?: number;
  note?: string;
  confirm?: { reason: string };
}

export interface LineSpec {
  medicine: string | null;
  product: string | null;
  freeName?: string;
  dose: number | null;
  doseText?: string;
  unit: string;
  route: string;
  frequency: string;
  durationDays: number | null;
  quantity: number | null;
  note?: string;
  replaces?: Types.ObjectId | string;
  /** A pre-made line id: adding the same spec twice then makes one line. */
  id?: Types.ObjectId | string;
  prescriptionItem?: string;
  prescriptionRev?: number;
  confirm?: { by: { id: string; name: string }; reason: string };
}

export interface RecheckResult {
  line: PharmacyLineDocument;
  newRed: Flag[];
  reason: 'order' | 'prescription' | 'kidney' | 'procedure' | 'discharge-cancelled';
}

export interface CreateOrderInput {
  patient: { _id: unknown; uhid: string; name: string };
  priority: Priority;
  orderedBy: By;
  note?: string;
  source: 'order' | 'prescription';
  prescription?: Types.ObjectId | string;
  prescriptionRev?: number;
  /** A prescription order is always OPD; a direct order takes the patient's current location. */
  setting?: PharmacySetting;
  /** The case the order must land on (it must be this patient's open case); without it the order opens or joins one. */
  caseId?: string;
  takeHome?: boolean;
  /** Clinic clock; take-home orders only. */
  plannedLeaveAt?: Date;
  /** Real time; take-home orders only: no check or issue is due before it. */
  dueFrom?: Date;
}

/** Internal options of `order` (the public route passes none): the Discharge Agent's take-home order uses them. */
export interface OrderOptions {
  setting?: PharmacySetting;
  takeHome?: boolean;
  plannedLeaveAt?: Date;
  /** Real time; take-home only: no check or issue is due before it (see the order schema). */
  dueFrom?: Date;
  caseId?: string;
}

/** Where lines sit, for the take-home continuation rule (see `continues` in pharmacy-rules.ts). */
export type LineContext = Pick<CheckLine, 'caseId' | 'takeHome' | 'setting'>;

/** The context of an order's lines. */
export const orderContext = (o: { case: unknown; setting: PharmacySetting; takeHome?: boolean; takeHomeCancelledAt?: Date | null }): LineContext => ({
  caseId: String(o.case),
  setting: o.setting,
  // B3-M4: a take-home order whose discharge was cancelled no longer continues anything.
  takeHome: !!o.takeHome && !o.takeHomeCancelledAt,
});
/** The order fields `orderContext` reads. */
const CONTEXT_FIELDS = 'case setting takeHome takeHomeCancelledAt';
type ContextFields = { case: Types.ObjectId; setting: PharmacySetting; takeHome?: boolean; takeHomeCancelledAt?: Date };

export interface PreviewResult {
  patient: PatientFactsView;
  lines: { flags: FlagView[]; quantity: number | null }[];
}

export interface OrderListQuery {
  status?: PharmacyLineStatus;
  search?: string;
  setting?: PharmacySetting;
  patientId?: string;
  limit?: number;
}

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const pad = (n: number, w: number) => String(n).padStart(w, '0');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isFrequency = (v: unknown): v is Frequency => typeof v === 'string' && Object.prototype.hasOwnProperty.call(DOSES_PER_DAY, v);

const asCheckLine = (l: { medicine: string | null; dose: number | null; frequency: string; doseText?: string }): CheckLine => ({
  medicine: l.medicine,
  dose: l.dose,
  frequency: isFrequency(l.frequency) ? l.frequency : 'OD',
  doseReadable: l.dose === null && !!l.doseText ? false : undefined,
});

/** Medicine orders: creating them, the checks against the patient's other medicines, and every read of them. */
@Injectable()
export class PharmacyOrdersService {
  private readonly logger = new Logger(PharmacyOrdersService.name);
  private readonly added: ((order: PharmacyOrderDocument, lines: PharmacyLineDocument[]) => Promise<void>)[] = [];
  private readonly rechecked: ((results: RecheckResult[]) => Promise<void>)[] = [];
  private readonly rounds: PharmacyRounds;

  constructor(
    @InjectModel(PharmacyOrder.name) private readonly orders: Model<PharmacyOrderDocument>,
    @InjectModel(PharmacyLine.name) private readonly lines: Model<PharmacyLineDocument>,
    @InjectModel(PharmacyLocation.name) private readonly locations: Model<PharmacyLocationDocument>,
    @InjectModel(CoordinatorCounter.name) private readonly counters: Model<CoordinatorCounterDocument>,
    private readonly patients: PatientsService,
    private readonly cases: CasesService,
    private readonly messages: MessagesService,
    private readonly settings: PharmacySettingsService,
    private readonly facts: PharmacyPatientsService,
  ) {
    this.rounds = new PharmacyRounds(orders, lines, messages, settings);
  }

  // ---------- rounds and messages (see pharmacy-rounds.ts) ----------

  syncRounds(orderId: string) {
    return this.rounds.syncRounds(orderId);
  }
  publish(orderId: string, events: LineEvent[]): Promise<ClockState> {
    return this.rounds.publish(orderId, events);
  }
  sendDone(orderId: string, clock: 'check' | 'issue', round: number): Promise<void> {
    return this.rounds.sendDone(orderId, clock, round);
  }
  resendStart(orderId: string, clock: 'check' | 'issue', keySuffix?: string): Promise<boolean> {
    return this.rounds.resendStart(orderId, clock, keySuffix);
  }
  announceOrdered(order: PharmacyOrderDocument): Promise<boolean> {
    return this.rounds.announceOrdered(order);
  }

  // ---------- ordering ----------

  /**
   * Checks a doctor's lines against the patient and their active medicines, without saving anything. `ctx` says where
   * the lines will sit (a take-home order passes its own). Without it: where the replaced line sits, for an answer;
   * else where a direct order would, on the patient's open case (the one the order joins) at its location.
   */
  async preview(input: { patientId: string; lines: LineInput[]; replacingLineId?: string }, ctx?: LineContext): Promise<PreviewResult> {
    const patient = await this.patients.findOne(String(input.patientId));
    const specs = this.validate(input.lines);
    const facts = await this.facts.facts(String(patient._id));
    // A line being replaced by an answer (Change, Switch) is left out of the comparison and checked where it sits, as the answer's own check does.
    const exclude: string[] = [];
    let where = ctx;
    if (input.replacingLineId !== undefined) {
      const own = isValidObjectId(input.replacingLineId) ? await this.lines.findOne({ _id: input.replacingLineId, patient: patient._id }).select('_id order').lean().exec() : null;
      if (!own) throw new BadRequestException('replacingLineId must be a medicine line of this patient');
      exclude.push(String(own._id));
      const order = await this.orders.findById(own.order).select(CONTEXT_FIELDS).lean<ContextFields>().exec();
      where ??= order ? orderContext(order) : undefined;
    }
    const drafts = await this.draftFlags(String(patient._id), facts, specs, exclude, where ?? (await this.directContext(String(patient._id))));
    return {
      patient: facts,
      lines: specs.map((s, i) => ({ flags: drafts[i].map((d) => flagView({ ...d, version: 1 })), quantity: s.quantity })),
    };
  }

  /**
   * A doctor orders medicines: 1 to 10 lines at one priority. `opts` is internal (the public route passes none):
   * the Discharge Agent's take-home order sets its setting, the take-home mark, the leaving time and its case.
   */
  async order(actor: Actor, input: { patientId: string; priority: Priority; note?: string; lines: LineInput[] }, opts: OrderOptions = {}): Promise<PharmacyOrderView> {
    if (!(PHARMACY_PRIORITIES as readonly string[]).includes(input.priority)) throw new BadRequestException('Priority must be stat, urgent or routine');
    const patient = await this.patients.findOne(String(input.patientId));
    const specs = this.validate(input.lines);
    const confirm = input.lines.map((l) => (l?.confirm && text(l.confirm.reason) ? { by: { id: actor.id, name: actor.name }, reason: text(l.confirm.reason) } : undefined));
    const facts = await this.facts.facts(String(patient._id));
    // Only the allergy flags are read here, and they do not depend on where the lines sit: addLines saves the full checks.
    const drafts = await this.draftFlags(String(patient._id), facts, specs);
    // A red allergy needs the doctor's reason on that line, or the line goes.
    drafts.forEach((d, i) => {
      if (d.some((f) => f.kind === 'allergy' && f.severity === 'red') && !confirm[i]) {
        throw new BadRequestException(`Confirm the allergy for ${medicineByKey(specs[i].medicine!)?.name ?? 'this medicine'} with a reason, or remove it`);
      }
    });
    specs.forEach((s, i) => (s.confirm = confirm[i]));

    const order = await this.createOrder({
      patient, priority: input.priority, orderedBy: { id: actor.id, name: actor.name }, note: input.note, source: 'order',
      setting: opts.setting, caseId: opts.caseId, takeHome: opts.takeHome, plannedLeaveAt: opts.plannedLeaveAt, dueFrom: opts.dueFrom,
    });
    let added: PharmacyLineDocument[];
    try {
      added = await this.addLines(order, specs);
    } catch (e) {
      // No order stays behind without its lines.
      await this.lines.deleteMany({ order: order._id }).exec().catch(() => undefined);
      await this.orders.deleteOne({ _id: order._id }).exec().catch(() => undefined);
      throw e;
    }
    await this.recheckPatient(String(patient._id), 'order', { skip: added.map((l) => String(l._id)) });
    await this.announceOrdered(order);
    const fresh = await this.lines.find({ _id: { $in: added.map((l) => l._id) }, status: 'to-check' }).sort({ _id: 1 }).exec();
    await this.publish(String(order._id), fresh.map((l) => ({ type: 'pharmacy.to-check' as const, lineId: String(l._id), dedupeKey: startKey('pharmacy.to-check', l) })));
    return this.get(String(order._id));
  }

  /**
   * Makes an order: its number, its Coordinator case (opened or joined) and its setting. Direct orders and
   * prescriptions both use it. It adds no lines and sends nothing.
   */
  async createOrder(input: CreateOrderInput): Promise<PharmacyOrderDocument> {
    const patientId = String(input.patient._id);
    const caseId = input.caseId !== undefined ? await this.joinGiven(patientId, input.caseId) : await this.openOrJoin(input);
    const where = input.setting ? { area: input.setting, ward: undefined as string | undefined } : await this.location(caseId);
    return this.orders.create({
      number: await this.nextNumber(),
      patient: patientId,
      patientUhid: input.patient.uhid,
      patientName: input.patient.name,
      case: caseId,
      setting: where.area,
      ...(where.ward ? { ward: where.ward } : {}),
      orderedBy: input.orderedBy,
      priority: input.priority,
      note: text(input.note),
      source: input.source,
      ...(input.prescription ? { prescription: input.prescription, prescriptionRev: input.prescriptionRev ?? 0 } : {}),
      ...(input.takeHome ? { takeHome: true } : {}),
      ...(input.plannedLeaveAt ? { plannedLeaveAt: input.plannedLeaveAt } : {}),
      ...(input.takeHome && input.dueFrom ? { dueFrom: input.dueFrom } : {}),
      orderedAt: clinicNow(),
    });
  }

  private async openOrJoin(input: CreateOrderInput): Promise<string> {
    const { case: theCase } = await this.cases.openOrJoin({
      patientId: String(input.patient._id),
      patientUhid: input.patient.uhid,
      patientName: input.patient.name,
      kind: 'opd',
      priority: CASE_PRIORITY[input.priority],
      openedBy: 'pharmacy',
    });
    return String(theCase._id);
  }

  /** The given case, which must be this patient's open case; Pharmacy joins it as an agent. */
  private async joinGiven(patientId: string, caseId: string): Promise<string> {
    const c = await this.cases.get(caseId);
    if (!c || String(c.patient) !== patientId) throw new BadRequestException('caseId must be a case of this patient');
    if (c.state !== 'open') throw new ConflictException("The patient's case is closed");
    await this.cases.addAgent(caseId, 'pharmacy');
    return String(c._id);
  }

  /** Where a direct order's lines would sit: the patient's open case (which the order joins) at its location; none without one. */
  private async directContext(patientId: string): Promise<LineContext> {
    const c = await this.cases.forPatient(patientId);
    if (!c || c.state !== 'open') return {};
    const caseId = String(c._id);
    return { caseId, setting: (await this.location(caseId)).area, takeHome: false };
  }

  /** Checks the doctor's input against the list and turns it into line specs (with quantity). */
  validate(inputs: LineInput[]): LineSpec[] {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_LINES) throw new BadRequestException('Choose 1 to 10 medicines');
    return inputs.map((l, i) => {
      const n = `Line ${i + 1}`;
      const med = typeof l?.medicine === 'string' ? medicineByKey(l.medicine) : undefined;
      if (!med) throw new BadRequestException(`${n}: choose a medicine from the list`);
      const product: ProductDef | undefined = typeof l.product === 'string' ? productByKey(l.product) : undefined;
      if (!product || product.medicine !== med.key) throw new BadRequestException(`${n}: choose one of ${med.name}'s products`);
      if (typeof l.route !== 'string' || !(product.routes as string[]).includes(l.route)) throw new BadRequestException(`${n}: route must be one of ${product.routes.join(', ')}`);
      if (typeof l.dose !== 'number' || !Number.isFinite(l.dose) || l.dose <= 0) throw new BadRequestException(`${n}: dose must be more than 0`);
      if (!isFrequency(l.frequency)) throw new BadRequestException(`${n}: frequency must be one of ${Object.keys(DOSES_PER_DAY).join(', ')}`);
      const days = l.durationDays;
      if (l.frequency === 'STAT') {
        if (days !== undefined && days !== null) throw new BadRequestException(`${n}: a STAT dose has no duration`);
      } else if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 90) {
        throw new BadRequestException(`${n}: duration must be a whole number of days from 1 to 90`);
      }
      if (l.confirm !== undefined && (typeof l.confirm?.reason !== 'string' || text(l.confirm.reason).length < 1 || l.confirm.reason.length > 300)) {
        throw new BadRequestException(`${n}: the reason must be 1 to 300 characters`);
      }
      const durationDays = l.frequency === 'STAT' ? null : (days as number);
      return {
        medicine: med.key,
        product: product.key,
        dose: l.dose,
        unit: med.unit,
        route: l.route,
        frequency: l.frequency,
        durationDays,
        quantity: quantityFor(product, l.dose, l.frequency, durationDays),
        note: text(l.note),
      };
    });
  }

  /**
   * The rule flags of specs for a patient, leaving out the lines in `exclude` (a line being changed must not clash with itself).
   * `ctx`: where the specs sit (a changed line passes its own order's context).
   */
  async draftSpecFlags(patientId: string, specs: LineSpec[], exclude: string[] = [], ctx: LineContext = {}): Promise<FlagDraft[][]> {
    return this.draftFlags(patientId, await this.facts.facts(patientId), specs, exclude, ctx);
  }

  /** The rule flags of each spec (all sitting at `ctx`), checked against the patient's active lines and the other specs. */
  private async draftFlags(patientId: string, facts: PatientFactsView, specs: LineSpec[], exclude: string[] = [], ctx: LineContext = {}): Promise<FlagDraft[][]> {
    const active = (await this.activeLines(patientId)).filter((l) => !exclude.includes(String(l.doc._id))).map((l) => l.check);
    const mine = specs.map((s) => ({ ...asCheckLine(s), ...ctx }));
    return specs.map((_, i) => checkLine(mine[i], facts, [...active, ...mine.filter((__, j) => j !== i)]));
  }

  /**
   * What the checks compare against: to-check, query and approved lines, and lines issued in the last 24 hours (real time),
   * each with its order's context (case, setting, take-home).
   */
  private async activeLines(patientId: string): Promise<{ doc: PharmacyLineDocument; check: CheckLine }[]> {
    const docs = await this.lines
      .find({
        patient: patientId,
        $or: [{ status: { $in: ['to-check', 'query', 'approved'] } }, { status: 'issued', 'issued.realAt': { $gte: new Date(Date.now() - ACTIVE_ISSUED_MS) } }],
      })
      .sort({ _id: 1 })
      .exec();
    const ids = [...new Set(docs.map((l) => String(l.order)))];
    const orders = ids.length
      ? await this.orders.find({ _id: { $in: ids } }).select(CONTEXT_FIELDS).lean<(ContextFields & { _id: Types.ObjectId })[]>().exec()
      : [];
    const where = new Map(orders.map((o) => [String(o._id), orderContext(o)] as [string, LineContext]));
    return docs.map((doc) => ({ doc, check: { ...asCheckLine(doc), ...where.get(String(doc.order)) } }));
  }

  /**
   * Saves the specs as lines in To check, with their flags and quantity. It sends nothing: the caller
   * announces the order and publishes the start messages once its own state is settled.
   */
  async addLines(order: PharmacyOrderDocument, specs: LineSpec[]): Promise<PharmacyLineDocument[]> {
    const patientId = String(order.patient);
    const facts = await this.facts.facts(patientId);
    const drafts = await this.draftFlags(patientId, facts, specs, [], orderContext(order));
    const out: PharmacyLineDocument[] = [];
    const now = clinicNow();
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      const flags: Flag[] = drafts[i].map((d) => {
        const flag: Flag = { ...d, version: 1 };
        if (s.confirm && d.kind === 'allergy' && d.severity === 'red') flag.confirmed = { by: s.confirm.by.name, reason: s.confirm.reason, at: now };
        return flag;
      });
      const product = s.product ? productByKey(s.product) : undefined;
      const quantity = product && s.dose !== null && isFrequency(s.frequency) ? quantityFor(product, s.dose, s.frequency, s.durationDays) : null;
      out.push(
        await this.lines.create({
          ...(s.id ? { _id: s.id } : {}),
          order: order._id,
          patient: order.patient,
          medicine: s.medicine,
          product: s.product,
          ...(s.freeName ? { freeName: s.freeName } : {}),
          dose: s.dose,
          ...(s.doseText ? { doseText: s.doseText } : {}),
          unit: s.unit,
          route: s.route,
          frequency: s.frequency,
          durationDays: s.durationDays,
          quantity,
          note: text(s.note),
          version: 1,
          status: 'to-check',
          enteredCheckAt: new Date(),
          flags,
          ...(s.replaces ? { replaces: s.replaces } : {}),
          ...(s.prescriptionItem ? { prescriptionItem: s.prescriptionItem } : {}),
          ...(s.prescriptionRev !== undefined ? { prescriptionRev: s.prescriptionRev } : {}),
        }),
      );
    }
    for (const l of this.added) {
      try {
        await l(order, out);
      } catch (e) {
        this.logger.error(`An added-lines listener failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  // ---------- rechecking ----------

  /** Listeners told of every batch of new lines (their own flags are already saved); a failure is logged. */
  onAdded(listener: (order: PharmacyOrderDocument, lines: PharmacyLineDocument[]) => Promise<void>): void {
    this.added.push(listener);
  }

  onRechecked(listener: (results: RecheckResult[]) => Promise<void>): void {
    this.rechecked.push(listener);
  }

  /**
   * Re-runs the rules on the patient's active lines (`opts.kinds`: only those kinds; `opts.skip`: line ids
   * just checked) and saves the merged flags, guarded on the line's version. Listeners get the lines whose
   * flags changed, with the red flags each gained; a listener's failure is logged.
   */
  async recheckPatient(patientId: string, reason: RecheckResult['reason'], opts: { kinds?: FlagKind[]; skip?: string[] } = {}): Promise<RecheckResult[]> {
    const facts = await this.facts.facts(patientId);
    const active = await this.activeLines(patientId);
    const skip = new Set(opts.skip ?? []);
    const results: RecheckResult[] = [];
    for (const { doc: line, check } of active) {
      if (skip.has(String(line._id))) continue;
      const others = active.filter((o) => String(o.doc._id) !== String(line._id)).map((o) => o.check);
      const sig = (fs: Flag[]) => JSON.stringify([...fs].sort((a, b) => a.key.localeCompare(b.key)));
      // The write is guarded on the version and on the flags it read, so a confirmation saved meanwhile is never overwritten:
      // on a lost write the line is read again and the merge re-run once (its order, and so its context, never changes).
      let cur: PharmacyLineDocument = line;
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = (cur.flags ?? []) as Flag[];
        const after = mergeFlags(before, checkLine({ ...check, ...asCheckLine(cur) }, facts, others), cur.version, opts.kinds);
        if (sig(before) === sig(after)) break;
        const saved = await this.lines.updateOne({ _id: cur._id, version: cur.version, flags: cur.flags }, { $set: { flags: after } }).exec();
        if (saved.modifiedCount) {
          cur.flags = after;
          results.push({ line: cur, newRed: newRed(before, after), reason });
          break;
        }
        const fresh = await this.lines.findById(cur._id).exec();
        if (!fresh) break;
        cur = fresh;
      }
    }
    if (results.length) {
      for (const l of this.rechecked) {
        try {
          await l(results);
        } catch (e) {
          this.logger.error(`A recheck listener failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return results;
  }

  /** The unconfirmed red allergy flags of a line (for callers that gate on them). */
  needsDoctor(line: PharmacyLineDocument): Flag[] {
    return needsDoctor((line.flags ?? []) as Flag[], line.version);
  }

  // ---------- location ----------

  /** Where the case's patient is: the record, else the case kind (er, ipd, opd). */
  async location(caseId: string): Promise<{ area: PharmacySetting; ward?: string }> {
    const rec = isValidObjectId(caseId) ? await this.locations.findOne({ case: caseId }).lean().exec() : null;
    if (rec) return rec.ward ? { area: rec.area, ward: rec.ward } : { area: rec.area };
    const c = isValidObjectId(caseId) ? await this.cases.get(caseId).catch(() => null) : null;
    const kind = (c as { kind?: string } | null)?.kind;
    return { area: kind === 'er' ? 'ER' : kind === 'ipd' ? 'Ward' : 'OPD' };
  }

  async setLocation(caseId: string, area: PharmacySetting, ward?: string): Promise<void> {
    if (!isValidObjectId(caseId)) return;
    const update = ward ? { $set: { area, ward } } : { $set: { area }, $unset: { ward: '' } };
    await this.locations.updateOne({ case: new Types.ObjectId(caseId) }, update, { upsert: true }).exec();
  }

  private async nextNumber(): Promise<string> {
    const c = await this.counters.findOneAndUpdate({ key: 'pharmacy-order' }, { $inc: { last: 1 } }, { upsert: true, new: true }).exec();
    return `MO-${pad(c.last, 4)}`;
  }

  // ---------- reading ----------

  async get(orderId: string): Promise<PharmacyOrderView> {
    const o = isValidObjectId(orderId) ? await this.orders.findById(orderId).exec() : null;
    if (!o) throw new NotFoundException('Pharmacy order not found');
    return (await this.orderViews([o]))[0];
  }

  async list(q: OrderListQuery = {}): Promise<PharmacyOrderView[]> {
    const filter: Record<string, unknown> = {};
    if (q.setting) filter.setting = q.setting;
    if (q.patientId) {
      if (!isValidObjectId(q.patientId)) return [];
      filter.patient = q.patientId;
    }
    const search = text(q.search);
    if (search) {
      const re = new RegExp(escapeRe(search), 'i');
      filter.$or = [{ number: re }, { patientUhid: re }, { patientName: re }];
    }
    if (q.status) {
      const ids = await this.lines.find({ status: q.status }).distinct('order').exec();
      filter._id = { $in: ids };
    }
    const limit = Math.min(Math.max(Number.isInteger(q.limit) ? (q.limit as number) : 50, 1), 200);
    const found = await this.orders.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit).exec();
    return this.orderViews(found);
  }

  async line(lineId: string): Promise<PharmacyLineView> {
    const l = isValidObjectId(lineId) ? await this.lines.findById(lineId).exec() : null;
    if (!l) throw new NotFoundException('Medicine line not found');
    return (await this.lineViews([l]))[0];
  }

  /** A patient's lines, newest first; `since` (an ISO time) leaves out older ones. */
  async linesForPatient(patientId: string, since?: string): Promise<PharmacyLineView[]> {
    if (!isValidObjectId(patientId)) return [];
    const filter: Record<string, unknown> = { patient: patientId };
    const from = since ? new Date(since) : null;
    if (from && !isNaN(from.getTime())) filter.createdAt = { $gte: from };
    return this.lineViews(await this.lines.find(filter).sort({ createdAt: -1, _id: -1 }).limit(WORKLIST_LIMIT).exec());
  }

  /** The ids of approved lines, oldest issue time first, for ER and Ward orders (`urgent`) or for OPD counter orders. */
  private async approvedIds(urgent: boolean): Promise<Types.ObjectId[]> {
    const rows = await this.lines
      .aggregate<{ _id: Types.ObjectId }>([
        { $match: { status: 'approved' } },
        { $lookup: { from: this.orders.collection.name, localField: 'order', foreignField: '_id', as: 'o' } },
        { $match: { 'o.setting': urgent ? { $ne: 'OPD' } : 'OPD' } },
        { $sort: { issueFrom: 1, _id: 1 } },
        { $limit: WORKLIST_LIMIT },
        { $project: { _id: 1 } },
      ])
      .exec();
    return rows.map((r) => r._id);
  }

  /** The pharmacist's lists: lines to check, lines to issue, and queries (open, then answered in the last 24 h). */
  async worklist(view: 'check' | 'issue' | 'queries'): Promise<PharmacyLineView[]> {
    if (view === 'check') {
      // STAT first, then red-flagged, then the other priorities, then oldest: sorted in the database so the limit never drops a STAT line.
      const ranked = await this.lines
        .aggregate<{ _id: Types.ObjectId }>([
          { $match: { status: 'to-check' } },
          { $lookup: { from: this.orders.collection.name, localField: 'order', foreignField: '_id', as: 'o' } },
          {
            $addFields: {
              prio: { $switch: { branches: [{ case: { $eq: [{ $first: '$o.priority' }, 'stat'] }, then: 0 }, { case: { $eq: [{ $first: '$o.priority' }, 'urgent'] }, then: 2 }], default: 3 } },
              red: { $cond: [{ $anyElementTrue: [{ $map: { input: { $ifNull: ['$flags', []] }, as: 'f', in: { $eq: ['$$f.severity', 'red'] } } }] }, 0, 1] },
            },
          },
          { $addFields: { sortRank: { $cond: [{ $eq: ['$prio', 0] }, 0, 1] } } },
          { $sort: { sortRank: 1, red: 1, prio: 1, enteredCheckAt: 1, _id: 1 } },
          { $limit: WORKLIST_LIMIT },
          { $project: { _id: 1 } },
        ])
        .exec();
      const rows = await this.lines.find({ _id: { $in: ranked.map((r) => r._id) } }).exec();
      const byId = new Map(rows.map((r) => [String(r._id), r] as [string, PharmacyLineDocument]));
      return this.lineViews(ranked.flatMap((r) => (byId.has(String(r._id)) ? [byId.get(String(r._id))!] : [])));
    }
    if (view === 'issue') {
      // ER and ward lines are fetched apart from OPD counter lines, each with its own limit, so uncollected counter lines can never hide an urgent one.
      const urgent = await this.approvedIds(true);
      const counter = await this.approvedIds(false);
      const rows = await this.lines.find({ _id: { $in: [...urgent, ...counter] } }).exec();
      const rank = new Map([...urgent, ...counter].map((id, i) => [String(id), i] as [string, number]));
      rows.sort((a, b) => rank.get(String(a._id))! - rank.get(String(b._id))!);
      const views = await this.lineViews(rows);
      return views.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
    }
    // Open queries first (soonest due), then those answered in the last 24 h (latest first): each fetched in its own order, never limited before it.
    const since = new Date(Date.now() - DAY_MS);
    const openRows = await this.lines.find({ query: { $exists: true }, 'query.answer': { $exists: false } }).sort({ 'query.dueAt': 1, _id: 1 }).limit(WORKLIST_LIMIT).exec();
    const answeredRows = openRows.length >= WORKLIST_LIMIT
      ? []
      : await this.lines.find({ query: { $exists: true }, 'query.answer.realAt': { $gte: since } }).sort({ 'query.answer.realAt': -1, _id: -1 }).limit(WORKLIST_LIMIT - openRows.length).exec();
    const views = await this.lineViews([...openRows, ...answeredRows]);
    const open = views.filter((v) => !v.query?.answer).sort((a, b) => a.query!.dueAt.localeCompare(b.query!.dueAt));
    const answered = views.filter((v) => v.query?.answer).sort((a, b) => b.query!.answer!.at.localeCompare(a.query!.answer!.at));
    return [...open, ...answered];
  }
  private async orderViews(orders: PharmacyOrderDocument[]): Promise<PharmacyOrderView[]> {
    const lines = await this.lines.find({ order: { $in: orders.map((o) => o._id) } }).sort({ _id: 1 }).exec();
    return buildOrderViews(orders, await this.lineViews(lines, orders));
  }

  private async lineViews(lines: PharmacyLineDocument[], knownOrders?: PharmacyOrderDocument[]): Promise<PharmacyLineView[]> {
    if (!lines.length) return [];
    const ids = [...new Set(lines.map((l) => String(l.order)))];
    const orders = new Map<string, PharmacyOrderDocument>((knownOrders ?? (await this.orders.find({ _id: { $in: ids } }).exec())).map((o) => [String(o._id), o] as [string, PharmacyOrderDocument]));
    const targets = await this.settings.targets();
    const facts = new Map<string, PatientFactsView>();
    const where = new Map<string, { area: PharmacySetting; ward?: string }>();
    for (const l of lines) {
      const o = orders.get(String(l.order));
      if (!o) continue;
      if (!facts.has(String(l.patient))) facts.set(String(l.patient), await this.facts.facts(String(l.patient)));
      if (!where.has(String(o.case))) where.set(String(o.case), await this.location(String(o.case)));
    }
    return buildLineViews(lines, orders, targets, facts, where);
  }
}
