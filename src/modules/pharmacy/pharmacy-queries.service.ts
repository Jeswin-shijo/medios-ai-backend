import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow, displayDateTime } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { TaskAlertDocument } from '../tasks-alerts/schemas/task-alert.schema';
import { productByKey } from './pharmacy-catalogue';
import { LineEvent, LineInput, LineSpec, PharmacyLineView, PharmacyOrdersService, RecheckResult } from './pharmacy-orders.service';
import { medicineLabel, startKey } from './pharmacy-rounds';
import { Flag, needsDoctor, needsReason, needsReview } from './pharmacy-rules';
import { PharmacySettingsService } from './pharmacy-settings.service';
import { PharmacyLineDocument, QueryKind, ReplacementSpec } from './schemas/pharmacy-line.schema';
import type { PharmacyOrderDocument } from './schemas/pharmacy-order.schema';

type By = { id: string; name: string };

/** Who the Pharmacy Agent acts as when it opens a query itself. */
export const PHARMACY_AGENT: By = { id: 'pharmacy-agent', name: 'Pharmacy Agent' };

export interface AnswerInput {
  outcome: string;
  reason?: string;
  change?: { product: string; dose: number; route: string; frequency: string; durationDays?: number; confirm?: { reason: string } };
  switchTo?: LineInput;
}

export interface QueryOpening {
  kind: QueryKind;
  question: string;
  by: By;
  suggestions?: string[];
  /** The pharmacist's check of the line starts with this query: stamp `checkedAt` in the same guarded write. */
  markChecked?: boolean;
}

const MIN_MS = 60_000;
const NOT_FIT = "That answer doesn't fit this query";
export const AUTO_ALLERGY_ASK = 'Please confirm with a reason, change the dose, or cancel.';

export const cleanText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** "Enoxaparin 60 mg": what an alert or message calls a line. */
export const lineName = (l: { medicine: string | null; dose: number | null; unit: string }): string =>
  `${medicineLabel(l.medicine)}${l.dose === null ? '' : ` ${l.dose} ${l.unit}`}`;

/** Queries to the doctor: opening one, answering it (the one path), and the alert that rides on it. */
export class PharmacyQueries {
  private readonly logger = new Logger(PharmacyQueries.name);

  constructor(
    private readonly lines: Model<PharmacyLineDocument>,
    private readonly orderDocs: Model<PharmacyOrderDocument>,
    private readonly alerts: Model<TaskAlertDocument>,
    private readonly orders: PharmacyOrdersService,
    private readonly settings: PharmacySettingsService,
  ) {}

  async load(lineId: string): Promise<PharmacyLineDocument> {
    const line = isValidObjectId(lineId) ? await this.lines.findById(lineId).lean<PharmacyLineDocument>().exec() : null;
    if (!line) throw new NotFoundException('Medicine line not found');
    return line;
  }

  private async orderOf(line: { order: unknown }): Promise<PharmacyOrderDocument> {
    const o = await this.orderDocs.findById(line.order).exec();
    if (!o) throw new NotFoundException('Pharmacy order not found');
    return o;
  }

  hasOpenQuery(line: { query?: { answer?: unknown } }): boolean {
    return !!line.query && !line.query.answer;
  }

  // ---------- opening ----------

  /**
   * The one way a query opens. Guarded on the line having no open query (and the query count it read), so
   * two openers never make two. A not-issued line becomes `query`; an issued line stays `issued`.
   * Returns false when the line could not take a query now.
   */
  async openQuery(lineId: string, q: QueryOpening): Promise<boolean> {
    const line = await this.load(lineId);
    if (!['to-check', 'approved', 'issued'].includes(line.status) || this.hasOpenQuery(line)) return false;
    const order = await this.orderOf(line);
    const targets = await this.settings.targets();
    const now = new Date();
    const seq = line.querySeq + 1;
    const dueAt = new Date(now.getTime() + targets.query[order.priority] * MIN_MS);
    const opened = await this.lines
      .updateOne(
        { _id: line._id, status: line.status, querySeq: line.querySeq, $or: [{ query: { $exists: false } }, { 'query.answer': { $exists: true } }] },
        {
          $inc: { querySeq: 1 },
          $set: {
            ...(line.status === 'issued' ? {} : { status: 'query' }),
            ...(q.markChecked ? { checkedAt: now } : {}),
            query: {
              seq,
              kind: q.kind,
              question: q.question,
              by: q.by,
              at: clinicNow(),
              openedRealAt: now,
              dueAt,
              suggestions: q.suggestions ?? [],
              redKeys: ((line.flags ?? []) as Flag[]).filter((f) => f.severity === 'red' && !(f.confirmed && f.version === line.version)).map((f) => f.key),
            },
          },
        },
      )
      .exec();
    if (!opened.modifiedCount) return false;
    await this.raiseQueryAlert(lineId);
    const queryDueAt = dueAt;
    // The message names the query it opens: it is never read from the line at send time.
    await this.orders.publish(String(line.order), [{ type: 'pharmacy.query', lineId, extra: { querySeq: seq, kind: q.kind, queryDueAt }, dedupeKey: `pharmacy.query:${lineId}:${seq}` }]);
    return true;
  }

  /** One alert per line: a later query reuses it, restoring its title, priority and Pending and clearing an old escalation. */
  async raiseQueryAlert(lineId: string): Promise<void> {
    const line = await this.load(lineId);
    if (!line.query || line.query.answer) return;
    const order = await this.orderOf(line);
    const minutes = Math.max(1, Math.round((new Date(line.query.dueAt).getTime() - new Date(line.query.openedRealAt).getTime()) / MIN_MS));
    await this.alerts
      .updateOne(
        { link: `pharmacy-line:${lineId}` },
        {
          $unset: { escalation: '' },
          $set: {
            title: `Pharmacy query: ${lineName(line)} (${line.query.kind})`,
            subtitle: `For ${order.orderedBy.name} · ${order.number} · answer within ${minutes} min`,
            querySeq: line.query.seq,
            patientName: order.patientName,
            uhid: order.patientUhid,
            type: 'Medication Alert',
            category: 'Medication',
            priority: 'High',
            status: 'Pending',
            dueDateTime: displayDateTime(new Date(clinicNow().getTime() + minutes * MIN_MS)),
          },
        },
        { upsert: true },
      )
      .exec();
    // The query may have been answered while the alert was written: leave nothing Pending for it.
    await this.completeQueryAlert(lineId, line.query.seq);
  }

  /**
   * Completes the line's alert. With `seq`, only that query's alert (an old answer never completes a newer
   * query's alert); without it, only while the line has no open query.
   */
  async completeQueryAlert(lineId: string, seq?: number): Promise<void> {
    const line = await this.load(lineId);
    if (seq === undefined ? this.hasOpenQuery(line) : line.query?.seq === seq && !line.query.answer) return;
    await this.alerts.updateOne({ link: `pharmacy-line:${lineId}`, ...(seq === undefined ? {} : { querySeq: seq }) }, { $set: { status: 'Completed' } }).exec();
  }

  /** Opens an allergy query (by the Pharmacy Agent) on each line that has an unconfirmed red allergy flag. */
  async holdAtOnce(lines: PharmacyLineDocument[]): Promise<void> {
    for (const l of lines) {
      const fresh = await this.load(String(l._id));
      const flag = needsDoctor((fresh.flags ?? []) as Flag[], fresh.version)[0];
      if (!flag || this.hasOpenQuery(fresh)) continue;
      await this.openQuery(String(fresh._id), { kind: 'allergy', question: `${flag.text}. ${AUTO_ALLERGY_ASK}`, by: PHARMACY_AGENT });
    }
  }

  /**
   * After a recheck: a newly red allergy flag holds the line in an allergy query, and a newly red kidney flag
   * (on a kidney recheck) opens a kidney query. A line with an open query gets no second one. Every line whose
   * flags changed arrives here, so only the newly added red flags matter.
   */
  async onRechecked(results: RecheckResult[]): Promise<void> {
    for (const r of results) {
      try {
        const id = String(r.line._id);
        const fresh = await this.load(id);
        if (this.hasOpenQuery(fresh)) continue;
        const allergy = r.newRed.find((f) => f.kind === 'allergy' && needsDoctor((fresh.flags ?? []) as Flag[], fresh.version).some((n) => n.key === f.key));
        if (allergy) {
          await this.openQuery(id, { kind: 'allergy', question: `${allergy.text}. ${AUTO_ALLERGY_ASK}`, by: PHARMACY_AGENT });
          continue;
        }
        const kidney = r.reason === 'kidney' ? r.newRed.find((f) => f.kind === 'kidney') : undefined;
        if (kidney) {
          const egfr = /eGFR (\d+)/.exec(kidney.text)?.[1] ?? '?';
          await this.openQuery(id, { kind: 'kidney', question: `Dose may need lowering for kidney function (eGFR ${egfr}). Please review.`, by: PHARMACY_AGENT });
        }
      } catch (e) {
        this.logger.error(`Holding a rechecked line failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // ---------- answering ----------

  /** The doctor's (or admin's) one answer to the open query. */
  async answer(actor: Actor, lineId: string, input: AnswerInput): Promise<PharmacyLineView> {
    const line = await this.load(lineId);
    const q = line.query;
    if (!q || q.answer || !['query', 'issued'].includes(line.status)) throw new ConflictException('This line has no open query');
    const issued = line.status === 'issued';
    const allowed = q.kind === 'stock' ? ['switch', 'wait', 'cancel'] : issued ? ['change', 'keep', 'stop'] : ['change', 'keep', 'cancel'];
    const outcome = input?.outcome;
    if (typeof outcome !== 'string' || !allowed.includes(outcome)) throw new BadRequestException(NOT_FIT);
    // A wait is for a line that was approved at this version.
    if (outcome === 'wait' && !(line.approved && (line.approved.version ?? line.version) === line.version)) throw new BadRequestException(NOT_FIT);
    const reason = cleanText(input.reason);
    if (reason.length > 300 || (['keep', 'cancel', 'stop'].includes(outcome) && reason.length < 1)) throw new BadRequestException('Give a reason of 1 to 300 characters');

    const by = { id: actor.id, name: actor.name };
    const answer: NonNullable<NonNullable<PharmacyLineDocument['query']>['answer']> = { outcome, by, reason, at: clinicNow(), realAt: new Date() };
    const guard: Record<string, unknown> = { _id: line._id, status: line.status, version: line.version, 'query.seq': q.seq, 'query.answer': { $exists: false } };
    const set: Record<string, unknown> = { 'query.answer': answer };
    const extra: Record<string, unknown> = {};
    // Every message names the query it concerns: the clock ref is never read from the line at send time.
    const events: LineEvent[] = [{ type: 'pharmacy.query-answered', lineId, extra: { querySeq: q.seq, outcome }, dedupeKey: `pharmacy.query-answered:${lineId}:${q.seq}` }];
    const unset: Record<string, ''> = {};
    let afterKeep = false;
        const doneKey = (type: 'pharmacy.cancelled' | 'pharmacy.stopped'): LineEvent => ({ type, lineId, extra: { querySeq: q.seq }, dedupeKey: `${type}:${lineId}` });
    const confirmOf = (c?: { reason: string }) => (c && cleanText(c.reason) ? { by, reason: cleanText(c.reason) } : undefined);

    if (outcome === 'keep') {
      // Keep confirms only the red flags the line carried when the query opened (an old query without the record: its own kind),
      // and an allergy only on an allergy query: an allergy that arrived meanwhile is never confirmed implicitly.
      const seen = (f: Flag) => (q.redKeys ? q.redKeys.includes(f.key) : f.kind === q.kind || f.kind !== 'allergy');
      const flags = ((line.flags ?? []) as Flag[]).map((f) =>
        f.severity === 'red' && !(f.confirmed && f.version === line.version) && seen(f) && (f.kind !== 'allergy' || q.kind === 'allergy')
          ? { ...f, confirmed: { by: actor.name, reason, at: clinicNow() } }
          : f,
      );
      afterKeep = needsDoctor(flags, line.version).length > 0;
      guard.flags = line.flags;
      set.flags = flags;
      if (!issued) {
        Object.assign(set, { status: 'to-check', enteredCheckAt: new Date(), waitingForStock: false });
        unset.approved = '';
      }
    } else if (outcome === 'change' || outcome === 'switch') {
      const c = outcome === 'change' ? input.change : input.switchTo;
      if (!c || typeof c !== 'object') throw new BadRequestException(outcome === 'change' ? 'Say what to change the line to' : 'Choose the medicine to switch to');
      const product = typeof c.product === 'string' ? productByKey(c.product) : undefined;
      const spec = this.orders.validate([{ ...(c as LineInput), medicine: outcome === 'switch' ? (c as LineInput).medicine : (product?.medicine ?? '') }])[0];
      spec.note = line.note;
      const confirm = confirmOf(c.confirm);
      if (confirm) spec.confirm = confirm;
      // The same red-allergy gate as ordering: a doctor's reason on the new line, or it is refused (before anything changes).
      const [drafts] = await this.orders.draftSpecFlags(String(line.patient), [spec], [lineId]);
      const red = drafts.find((f) => f.kind === 'allergy' && f.severity === 'red');
      if (red && !confirm) throw new BadRequestException(`Confirm the allergy for ${medicineLabel(spec.medicine)} with a reason, or choose another`);
      if (outcome === 'change' && !issued) {
        const now = clinicNow();
        const version = line.version + 1;
        const flags: Flag[] = drafts.map((d) => ({ ...d, version, ...(confirm && d.kind === 'allergy' && d.severity === 'red' ? { confirmed: { by: actor.name, reason: confirm.reason, at: now } } : {}) }));
        Object.assign(set, {
          version, product: spec.product, dose: spec.dose, unit: spec.unit, route: spec.route, frequency: spec.frequency,
          durationDays: spec.durationDays, quantity: spec.quantity, flags, status: 'to-check', enteredCheckAt: new Date(), waitingForStock: false,
        });
        if (spec.medicine !== line.medicine) set.medicine = spec.medicine;
        unset.approved = '';
        extra.$push = {
          history: { version: line.version, product: line.product, dose: line.dose, unit: line.unit, route: line.route, frequency: line.frequency, durationDays: line.durationDays, quantity: line.quantity, flags: line.flags ?? [], by, at: now },
        };
      } else {
        // The replacement is stored with the answer, under its own pre-made id, in the same guarded write as the flip.
        const id = new Types.ObjectId();
        answer.replacement = {
          id: String(id), medicine: spec.medicine, product: spec.product, dose: spec.dose, unit: spec.unit, route: spec.route, frequency: spec.frequency,
          durationDays: spec.durationDays, quantity: spec.quantity, note: spec.note, ...(spec.confirm ? { confirm: spec.confirm } : {}),
        };
        if (outcome === 'change') {
          Object.assign(set, { status: 'stopped', stopped: { by, reason: reason || 'Changed by the doctor', at: clinicNow() } });
          events.push(doneKey('pharmacy.stopped'));
        } else {
          Object.assign(set, { status: 'cancelled', cancelled: { by, reason: reason || 'Switched to another medicine', at: clinicNow() } });
          events.push(doneKey('pharmacy.cancelled'));
        }
      }
    } else if (outcome === 'wait') {
      // A wait passes the approve gates like any approval: an open gate sends the line back to To check.
      const flags = (line.flags ?? []) as Flag[];
      guard.flags = line.flags;
      if (needsDoctor(flags, line.version).length || needsReason(flags, line.version).length || needsReview(flags, line.version).length) {
        Object.assign(set, { status: 'to-check', enteredCheckAt: new Date(), waitingForStock: false });
        unset.approved = '';
      } else {
        Object.assign(set, { status: 'approved', waitingForStock: true });
      }
    } else if (outcome === 'cancel') {
      Object.assign(set, { status: 'cancelled', cancelled: { by, reason, at: clinicNow() } });
      events.push(doneKey('pharmacy.cancelled'));
    } else {
      Object.assign(set, { status: 'stopped', stopped: { by, reason, at: clinicNow() } });
      events.push(doneKey('pharmacy.stopped'));
    }

    const saved = await this.lines.updateOne(guard, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), ...extra }).exec();
    if (!saved.modifiedCount) throw new ConflictException('This query was already answered, or the line just changed. Reload and try again.');

    if (set.status === 'to-check') {
      const back = await this.load(lineId);
      events.push({ type: 'pharmacy.to-check', lineId, dedupeKey: startKey('pharmacy.to-check', back) });
    }
    if (answer.replacement) {
      // A failure here is logged, not thrown: the answer stands and ensureReplacement (Task 6 reconcile) adds the stored line.
      await this.ensureReplacement(lineId).catch((e) => this.logger.error(`Adding the replacement of line ${lineId} failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    await this.completeQueryAlert(lineId, q.seq);
    await this.orders.publish(String(line.order), events);
    // A red allergy Keep did not confirm gets its own allergy query for a doctor.
    if ((outcome === 'wait' && set.status === 'to-check') || afterKeep) await this.holdAtOnce([line]);
    return this.orders.line(lineId);
  }

  /**
   * Adds the replacement stored on an answered Change or Switch if it is not there yet (it carries a pre-made id,
   * so a repeat or a race adds nothing twice). Returns the line it added, or null.
   */
  async ensureReplacement(lineId: string): Promise<PharmacyLineDocument | null> {
    const line = await this.load(lineId);
    const r = line.query?.answer?.replacement;
    if (!r || (await this.lines.exists({ _id: r.id }).exec())) return null;
    const order = await this.orderOf(line);
    const spec: LineSpec = {
      id: r.id, replaces: lineId, medicine: r.medicine, product: r.product, dose: r.dose, unit: r.unit, route: r.route, frequency: r.frequency,
      durationDays: r.durationDays, quantity: r.quantity, note: r.note, ...(r.confirm ? { confirm: r.confirm } : {}),
    };
    let added: PharmacyLineDocument;
    try {
      [added] = await this.orders.addLines(order, [spec]);
    } catch (e) {
      if ((e as { code?: number }).code === 11000) return null;
      throw e;
    }
    await this.orders.recheckPatient(String(line.patient), 'order', { skip: [String(added._id)] });
    await this.holdAtOnce([added]);
    await this.orders.publish(String(line.order), [{ type: 'pharmacy.to-check', lineId: String(added._id), dedupeKey: startKey('pharmacy.to-check', added) }]);
    return added;
  }
}
