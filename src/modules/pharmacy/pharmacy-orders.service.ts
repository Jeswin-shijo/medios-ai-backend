import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const MAX_LINES = 10;
const WORKLIST_LIMIT = 300;
/** A line issued within this long (real time) still counts as active for the checks. */
const ACTIVE_ISSUED_MS = DAY_MS;
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
  prescriptionItem?: string;
  prescriptionRev?: number;
  confirm?: { by: { id: string; name: string }; reason: string };
}

export interface RecheckResult {
  line: PharmacyLineDocument;
  newRed: Flag[];
  reason: 'order' | 'prescription' | 'kidney';
}

export interface FlagView {
  key: string;
  kind: FlagKind;
  severity: 'red' | 'amber';
  text: string;
  confirmed: { by: string; reason: string; at: string } | null;
  reviewed: { by: string; at: string } | null;
}

export interface QueryView {
  seq: number;
  kind: string;
  question: string;
  by: { id: string; name: string };
  at: string;
  dueAt: string;
  suggestions: { medicine: string; label: string }[];
  answer: { outcome: string; by: { id: string; name: string }; reason: string; at: string } | null;
}

type By = { id: string; name: string };
export interface PharmacyLineView {
  id: string;
  orderId: string;
  orderNumber: string;
  priority: Priority;
  setting: PharmacySetting;
  defaultStore: 'main' | 'er';
  source: 'order' | 'prescription';
  status: PharmacyLineStatus;
  medicine: string | null;
  medicineLabel: string;
  product: string | null;
  productLabel: string;
  freeName: string | null;
  dose: number | null;
  unit: string;
  route: string;
  frequency: string;
  durationDays: number | null;
  quantity: number | null;
  issueUnit: string;
  note: string;
  version: number;
  flags: FlagView[];
  query: QueryView | null;
  approved: { by: By; at: string; reason: string | null } | null;
  rejected: { by: By; reason: string; at: string } | null;
  issued: { by: By; at: string; store: string; batches: { batch: string; batchNo: string; expiry: string; qty: number }[] } | null;
  cancelled: { by: By; reason: string; at: string } | null;
  stopped: { by: By; reason: string; at: string } | null;
  waitingForStock: boolean;
  replaces: string | null;
  prescriptionItem: string | null;
  checkDueAt: string | null;
  issueDueAt: string | null;
  orderedBy: By;
  orderedAt: string;
  patient: {
    id: string;
    name: string;
    uhid: string;
    location: { area: PharmacySetting; ward?: string };
    allergies: string[];
    weightKg: number | null;
    age: number | null;
    sex: 'M' | 'F' | 'Other' | null;
    egfr: number | null;
    egfrAt: string | null;
  };
}

export interface PharmacyOrderView {
  id: string;
  number: string;
  patientId: string;
  patientUhid: string;
  patientName: string;
  caseId: string;
  setting: PharmacySetting;
  ward: string | null;
  orderedBy: By;
  priority: Priority;
  note: string;
  source: 'order' | 'prescription';
  prescriptionId: string | null;
  orderedAt: string;
  lines: PharmacyLineView[];
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

/** A flag as the views show it. */
export const flagView = (f: Flag): FlagView => ({
  key: f.key,
  kind: f.kind,
  severity: f.severity,
  text: f.text,
  confirmed: f.confirmed ? { by: f.confirmed.by, reason: f.confirmed.reason, at: iso(f.confirmed.at)! } : null,
  reviewed: f.reviewed ? { by: f.reviewed.by, at: iso(f.reviewed.at)! } : null,
});

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
  resendStart(orderId: string, clock: 'check' | 'issue'): Promise<boolean> {
    return this.rounds.resendStart(orderId, clock);
  }
  announceOrdered(order: PharmacyOrderDocument): Promise<boolean> {
    return this.rounds.announceOrdered(order);
  }

  // ---------- ordering ----------

  /** Checks a doctor's lines against the patient and their active medicines, without saving anything. */
  async preview(input: { patientId: string; lines: LineInput[] }): Promise<{ patient: PatientFactsView; lines: { flags: FlagView[]; quantity: number | null }[] }> {
    const patient = await this.patients.findOne(String(input.patientId));
    const specs = this.validate(input.lines);
    const facts = await this.facts.facts(String(patient._id));
    const drafts = await this.draftFlags(String(patient._id), facts, specs);
    return {
      patient: facts,
      lines: specs.map((s, i) => ({ flags: drafts[i].map((d) => flagView({ ...d, version: 1 })), quantity: s.quantity })),
    };
  }

  /** A doctor orders medicines: 1 to 10 lines at one priority. */
  async order(actor: Actor, input: { patientId: string; priority: Priority; note?: string; lines: LineInput[] }): Promise<PharmacyOrderView> {
    if (!(PHARMACY_PRIORITIES as readonly string[]).includes(input.priority)) throw new BadRequestException('Priority must be stat, urgent or routine');
    const patient = await this.patients.findOne(String(input.patientId));
    const specs = this.validate(input.lines);
    const confirm = input.lines.map((l) => (l?.confirm && text(l.confirm.reason) ? { by: { id: actor.id, name: actor.name }, reason: text(l.confirm.reason) } : undefined));
    const facts = await this.facts.facts(String(patient._id));
    const drafts = await this.draftFlags(String(patient._id), facts, specs);
    // A red allergy needs the doctor's reason on that line, or the line goes.
    drafts.forEach((d, i) => {
      if (d.some((f) => f.kind === 'allergy' && f.severity === 'red') && !confirm[i]) {
        throw new BadRequestException(`Confirm the allergy for ${medicineByKey(specs[i].medicine!)?.name ?? 'this medicine'} with a reason, or remove it`);
      }
    });
    specs.forEach((s, i) => (s.confirm = confirm[i]));

    const order = await this.createOrder({ patient, priority: input.priority, orderedBy: { id: actor.id, name: actor.name }, note: input.note, source: 'order' });
    const added = await this.addLines(order, specs);
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
    const { case: theCase } = await this.cases.openOrJoin({
      patientId,
      patientUhid: input.patient.uhid,
      patientName: input.patient.name,
      kind: 'opd',
      priority: CASE_PRIORITY[input.priority],
      openedBy: 'pharmacy',
    });
    const caseId = String(theCase._id);
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
      orderedAt: clinicNow(),
    });
  }

  /** Checks the doctor's input against the list and turns it into line specs (with quantity). */
  private validate(inputs: LineInput[]): LineSpec[] {
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

  /** The rule flags of each spec, checked against the patient's active lines and the other specs. */
  private async draftFlags(patientId: string, facts: PatientFactsView, specs: LineSpec[]): Promise<FlagDraft[][]> {
    const active = (await this.activeLines(patientId)).map(asCheckLine);
    const mine = specs.map(asCheckLine);
    return specs.map((_, i) => checkLine(mine[i], facts, [...active, ...mine.filter((__, j) => j !== i)]));
  }

  /** What the checks compare against: to-check, query and approved lines, and lines issued in the last 24 hours (real time). */
  private activeLines(patientId: string): Promise<PharmacyLineDocument[]> {
    return this.lines
      .find({
        patient: patientId,
        $or: [{ status: { $in: ['to-check', 'query', 'approved'] } }, { status: 'issued', 'issued.realAt': { $gte: new Date(Date.now() - ACTIVE_ISSUED_MS) } }],
      })
      .sort({ _id: 1 })
      .exec();
  }

  /**
   * Saves the specs as lines in To check, with their flags and quantity. It sends nothing: the caller
   * announces the order and publishes the start messages once its own state is settled.
   */
  async addLines(order: PharmacyOrderDocument, specs: LineSpec[]): Promise<PharmacyLineDocument[]> {
    const patientId = String(order.patient);
    const facts = await this.facts.facts(patientId);
    const drafts = await this.draftFlags(patientId, facts, specs);
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
    return out;
  }

  // ---------- rechecking ----------

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
    for (const line of active) {
      if (skip.has(String(line._id))) continue;
      const others = active.filter((o) => String(o._id) !== String(line._id)).map(asCheckLine);
      const before = (line.flags ?? []) as Flag[];
      const after = mergeFlags(before, checkLine(asCheckLine(line), facts, others), line.version, opts.kinds);
      const sig = (fs: Flag[]) => JSON.stringify([...fs].sort((a, b) => a.key.localeCompare(b.key)));
      if (sig(before) === sig(after)) continue;
      const saved = await this.lines.updateOne({ _id: line._id, version: line.version }, { $set: { flags: after } }).exec();
      if (!saved.modifiedCount) continue;
      line.flags = after;
      results.push({ line, newRed: newRed(before, after), reason });
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

  /** The pharmacist's lists: lines to check, lines to issue, and queries (open, then answered in the last 24 h). */
  async worklist(view: 'check' | 'issue' | 'queries'): Promise<PharmacyLineView[]> {
    if (view === 'check') {
      const views = await this.lineViews(await this.lines.find({ status: 'to-check' }).limit(WORKLIST_LIMIT).exec());
      const t = (v: PharmacyLineView) => v.checkDueAt ?? '';
      return views.sort(
        (a, b) =>
          Number(b.priority === 'stat') - Number(a.priority === 'stat') ||
          Number(b.flags.some((f) => f.severity === 'red')) - Number(a.flags.some((f) => f.severity === 'red')) ||
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          t(a).localeCompare(t(b)) ||
          a.id.localeCompare(b.id),
      );
    }
    if (view === 'issue') {
      const rows = await this.lines.find({ status: 'approved' }).sort({ issueFrom: 1, _id: 1 }).limit(WORKLIST_LIMIT).exec();
      const views = await this.lineViews(rows);
      return views.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
    }
    const since = new Date(Date.now() - DAY_MS);
    const rows = await this.lines
      .find({ query: { $exists: true }, $or: [{ 'query.answer': { $exists: false } }, { 'query.answer.realAt': { $gte: since } }] })
      .limit(WORKLIST_LIMIT)
      .exec();
    const views = await this.lineViews(rows);
    const open = views.filter((v) => !v.query?.answer).sort((a, b) => a.query!.dueAt.localeCompare(b.query!.dueAt));
    const answered = views.filter((v) => v.query?.answer).sort((a, b) => b.query!.answer!.at.localeCompare(a.query!.answer!.at));
    return [...open, ...answered];
  }

  private async orderViews(orders: PharmacyOrderDocument[]): Promise<PharmacyOrderView[]> {
    const lines = await this.lines.find({ order: { $in: orders.map((o) => o._id) } }).sort({ _id: 1 }).exec();
    const views = await this.lineViews(lines, orders);
    return orders.map((o) => ({
      id: String(o._id),
      number: o.number,
      patientId: String(o.patient),
      patientUhid: o.patientUhid,
      patientName: o.patientName,
      caseId: String(o.case),
      setting: o.setting,
      ward: o.ward ?? null,
      orderedBy: o.orderedBy,
      priority: o.priority,
      note: o.note ?? '',
      source: o.source,
      prescriptionId: o.prescription ? String(o.prescription) : null,
      orderedAt: iso(o.orderedAt)!,
      lines: views.filter((v) => v.orderId === String(o._id)),
    }));
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
    return lines.flatMap((l) => {
      const o = orders.get(String(l.order));
      if (!o) return [];
      const f = facts.get(String(l.patient))!;
      const product = l.product ? productByKey(l.product) : undefined;
      const created = o.createdAt ?? new Date();
      const checkDue = l.status === 'to-check' ? new Date(new Date(l.enteredCheckAt ?? created).getTime() + targets.check[o.priority] * MIN_MS) : null;
      const issueDue =
        l.status === 'approved' && !l.waitingForStock && o.setting !== 'OPD' ? new Date(new Date(l.issueFrom ?? created).getTime() + targets.issue[o.priority] * MIN_MS) : null;
      const q = l.query;
      const view: PharmacyLineView = {
        id: String(l._id),
        orderId: String(o._id),
        orderNumber: o.number,
        priority: o.priority,
        setting: o.setting,
        defaultStore: o.setting === 'ER' ? 'er' : 'main',
        source: o.source,
        status: l.status,
        medicine: l.medicine,
        medicineLabel: l.medicine ? (medicineByKey(l.medicine)?.name ?? l.medicine) : (l.freeName ?? 'Unlisted medicine'),
        product: l.product,
        productLabel: product?.label ?? l.freeName ?? 'Unlisted medicine',
        freeName: l.freeName ?? null,
        dose: l.dose,
        unit: l.unit,
        route: l.route,
        frequency: l.frequency,
        durationDays: l.durationDays,
        quantity: l.quantity,
        issueUnit: product?.issueUnit ?? '',
        note: l.note ?? '',
        version: l.version,
        flags: ((l.flags ?? []) as Flag[]).map(flagView),
        query: q
          ? {
              seq: q.seq,
              kind: q.kind,
              question: q.question,
              by: q.by,
              at: iso(q.at)!,
              dueAt: iso(q.dueAt)!,
              suggestions: (q.suggestions ?? []).map((m) => ({ medicine: m, label: medicineByKey(m)?.name ?? m })),
              answer: q.answer ? { outcome: q.answer.outcome, by: q.answer.by, reason: q.answer.reason, at: iso(q.answer.at)! } : null,
            }
          : null,
        approved: l.approved ? { by: l.approved.by, at: iso(l.approved.at)!, reason: l.approved.reason ?? null } : null,
        rejected: l.rejected ? { by: l.rejected.by, reason: l.rejected.reason, at: iso(l.rejected.at)! } : null,
        issued: l.issued ? { by: l.issued.by, at: iso(l.issued.at)!, store: l.issued.store, batches: l.issued.batches ?? [] } : null,
        cancelled: l.cancelled ? { by: l.cancelled.by, reason: l.cancelled.reason, at: iso(l.cancelled.at)! } : null,
        stopped: l.stopped ? { by: l.stopped.by, reason: l.stopped.reason, at: iso(l.stopped.at)! } : null,
        waitingForStock: !!l.waitingForStock,
        replaces: l.replaces ? String(l.replaces) : null,
        prescriptionItem: l.prescriptionItem ?? null,
        checkDueAt: iso(checkDue),
        issueDueAt: iso(issueDue),
        orderedBy: o.orderedBy,
        orderedAt: iso(o.orderedAt)!,
        patient: {
          id: String(l.patient),
          name: o.patientName,
          uhid: o.patientUhid,
          location: where.get(String(o.case))!,
          allergies: f.allergies,
          weightKg: f.weightKg,
          age: f.age,
          sex: f.sex,
          egfr: f.egfr,
          egfrAt: f.egfrAt,
        },
      };
      return [view];
    });
  }
}
