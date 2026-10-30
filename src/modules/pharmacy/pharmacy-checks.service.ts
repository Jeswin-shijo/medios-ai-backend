import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { CasesService } from '../coordinator/cases.service';
import { MessagesService } from '../coordinator/messages.service';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { LineEvent, PharmacyLineView, PharmacyOrdersService, RecheckResult } from './pharmacy-orders.service';
import { AnswerInput, PharmacyQueries, QueryOpening, cleanText, lineName } from './pharmacy-queries.service';
import { startKey } from './pharmacy-rounds';
import { Flag, needsDoctor, needsReason, needsReview } from './pharmacy-rules';
import { PharmacySettingsService } from './pharmacy-settings.service';
import { PharmacyLine, PharmacyLineDocument, QUERY_KINDS, QueryKind } from './schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderDocument } from './schemas/pharmacy-order.schema';

export type { AnswerInput } from './pharmacy-queries.service';
export { PHARMACY_AGENT } from './pharmacy-queries.service';

const lineBusy = 'This line just changed. Reload and try again.';

/**
 * The pharmacist's checks (approve, query, reject), cancelling, the doctor's answers, and the kidney recheck.
 * Queries and answers live in pharmacy-queries.service.ts; this class is the one door to them.
 */
@Injectable()
export class PharmacyChecksService {
  private readonly queries: PharmacyQueries;

  constructor(
    @InjectModel(PharmacyLine.name) private readonly lines: Model<PharmacyLineDocument>,
    @InjectModel(PharmacyOrder.name) private readonly orderDocs: Model<PharmacyOrderDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
    private readonly orders: PharmacyOrdersService,
    private readonly cases: CasesService,
    private readonly messages: MessagesService,
    settings: PharmacySettingsService,
  ) {
    this.queries = new PharmacyQueries(lines, orderDocs, alerts, orders, settings);
    this.orders.onRechecked((results: RecheckResult[]) => this.queries.onRechecked(results));
  }

  // ---------- the pharmacist ----------

  async approve(actor: Actor, lineId: string, input: { reason?: string; allergyReviewed?: boolean }): Promise<PharmacyLineView> {
    const line = await this.queries.load(lineId);
    if (line.status !== 'to-check') throw new ConflictException('This line is not waiting to be checked');
    const flags = (line.flags ?? []) as Flag[];
    if (needsDoctor(flags, line.version).length) throw new ConflictException('A doctor must confirm this allergy first. Query the doctor.');
    const reason = cleanText(input?.reason);
    const redOthers = needsReason(flags, line.version);
    if (reason.length > 300) throw new BadRequestException('The reason can be at most 300 characters');
    if (redOthers.length && reason.length < 1) throw new BadRequestException('A reason is required to approve a red flag');
    const unreviewed = needsReview(flags, line.version);
    if (unreviewed.length && !input?.allergyReviewed) throw new BadRequestException('Tick Allergy reviewed to approve');

    const by = { id: actor.id, name: actor.name };
    const now = clinicNow();
    const marked = flags.map((f) => {
      if (redOthers.some((r) => r.key === f.key)) return { ...f, confirmed: { by: actor.name, reason, at: now } };
      if (unreviewed.some((r) => r.key === f.key)) return { ...f, reviewed: { by: actor.name, at: now } };
      return f;
    });
    const real = new Date();
    // Guarded on the flags it read: a recheck that just added a red allergy flag makes this approval lose.
    const done = await this.lines
      .updateOne(
        { _id: line._id, status: 'to-check', version: line.version, flags: line.flags },
        {
          $set: {
            status: 'approved',
            approved: { by, at: now, version: line.version, ...(reason ? { reason } : {}) },
            checkedAt: real,
            issueFrom: real,
            waitingForStock: false,
            flags: marked,
          },
        },
      )
      .exec();
    if (!done.modifiedCount) throw new ConflictException(lineBusy);
    const order = await this.orderDocs.findById(line.order).exec();
    const events: LineEvent[] = [{ type: 'pharmacy.approved', lineId, dedupeKey: `pharmacy.approved:${lineId}:${line.version}:${real.getTime()}` }];
    if (order && order.setting !== 'OPD') events.push({ type: 'pharmacy.to-issue', lineId, dedupeKey: startKey('pharmacy.to-issue', { _id: line._id, issueFrom: real }) });
    await this.orders.publish(String(line.order), events);
    return this.orders.line(lineId);
  }

  async query(actor: Actor, lineId: string, input: { kind: QueryKind; question: string }): Promise<PharmacyLineView> {
    if (!(QUERY_KINDS as readonly string[]).includes(input?.kind)) throw new BadRequestException('Choose what the query is about');
    // Stock queries come only from Out of stock: a wait must never skip the approve gates.
    if (input.kind === 'stock') throw new BadRequestException('A stock query opens only from Out of stock');
    const question = cleanText(input.question);
    if (question.length < 1 || question.length > 500) throw new BadRequestException('Write the question in 1 to 500 characters');
    const line = await this.queries.load(lineId);
    if (line.status !== 'to-check') throw new ConflictException('This line is not waiting to be checked');
    const opened = await this.queries.openQuery(lineId, { kind: input.kind, question, by: { id: actor.id, name: actor.name }, markChecked: true });
    if (!opened) throw new ConflictException(lineBusy);
    return this.orders.line(lineId);
  }

  async reject(actor: Actor, lineId: string, reason: string): Promise<PharmacyLineView> {
    const text = cleanText(reason);
    if (text.length < 1 || text.length > 300) throw new BadRequestException('Give a reason of 1 to 300 characters');
    const line = await this.queries.load(lineId);
    if (line.status !== 'to-check') throw new ConflictException('This line is not waiting to be checked');
    const done = await this.lines
      .updateOne(
        { _id: line._id, status: 'to-check', version: line.version },
        { $set: { status: 'rejected', rejected: { by: { id: actor.id, name: actor.name }, reason: text, at: clinicNow() }, checkedAt: new Date() } },
      )
      .exec();
    if (!done.modifiedCount) throw new ConflictException(lineBusy);
    const order = await this.orderDocs.findById(line.order).exec();
    if (order) {
      await this.alerts
        .updateOne(
          { link: `pharmacy-rejected:${lineId}` },
          {
            $set: {
              title: `Rejected: ${lineName(line)}`,
              subtitle: `For ${order.orderedBy.name} · ${order.number} · ${text}`,
              patientName: order.patientName,
              uhid: order.patientUhid,
              type: 'Medication Alert',
              category: 'Medication',
              priority: 'Medium',
              status: 'Pending',
            },
          },
          { upsert: true },
        )
        .exec();
    }
    await this.orders.publish(String(line.order), [{ type: 'pharmacy.rejected', lineId, dedupeKey: `pharmacy.rejected:${lineId}` }]);
    return this.orders.line(lineId);
  }

  /** Cancels a to-check, query or approved line. An open query is closed by the cancel answer; an issued line is stopped only by an answer. */
  async cancel(actor: Actor, lineId: string, reason: string): Promise<PharmacyLineView> {
    const text = cleanText(reason);
    if (text.length < 1 || text.length > 300) throw new BadRequestException('Give a reason of 1 to 300 characters');
    const line = await this.queries.load(lineId);
    if (line.status === 'issued') throw new ConflictException('An issued line can be stopped only by answering a query');
    if (!['to-check', 'query', 'approved'].includes(line.status)) throw new ConflictException('This line is already closed');
    // Cancelling the line answers whichever query is open now (the one read here).
    if (line.query && this.queries.hasOpenQuery(line)) return this.answer(actor, lineId, { querySeq: line.query.seq, outcome: 'cancel', reason: text });
    const done = await this.lines
      .updateOne(
        { _id: line._id, status: line.status, version: line.version, querySeq: line.querySeq },
        { $set: { status: 'cancelled', cancelled: { by: { id: actor.id, name: actor.name }, reason: text, at: clinicNow() } } },
      )
      .exec();
    if (!done.modifiedCount) throw new ConflictException(lineBusy);
    await this.orders.publish(String(line.order), [{ type: 'pharmacy.cancelled', lineId, extra: { querySeq: line.querySeq }, dedupeKey: `pharmacy.cancelled:${lineId}` }]);
    return this.orders.line(lineId);
  }

  // ---------- queries and answers (see pharmacy-queries.service.ts) ----------

  openQuery(lineId: string, q: QueryOpening): Promise<boolean> {
    return this.queries.openQuery(lineId, q);
  }
  answer(actor: Actor, lineId: string, input: AnswerInput): Promise<PharmacyLineView> {
    return this.queries.answer(actor, lineId, input);
  }
  raiseQueryAlert(lineId: string): Promise<void> {
    return this.queries.raiseQueryAlert(lineId);
  }
  completeQueryAlert(lineId: string, seq?: number): Promise<void> {
    return this.queries.completeQueryAlert(lineId, seq);
  }
  ensureReplacement(lineId: string): Promise<PharmacyLineDocument | null> {
    return this.queries.ensureReplacement(lineId);
  }
  holdAtOnce(lines: PharmacyLineDocument[]): Promise<void> {
    return this.queries.holdAtOnce(lines);
  }

  // ---------- the kidney recheck ----------

  /** A released kidney test: re-runs only the kidney rules on the patient's active lines. Delivering it twice opens nothing new. */
  async onKidneyResult(messageId: string): Promise<void> {
    const message = await this.messages.get(messageId);
    if (!message?.case || (message.payload as Record<string, unknown> | undefined)?.test !== 'rft') return;
    const theCase = await this.cases.get(String(message.case));
    if (!theCase) return;
    await this.orders.recheckPatient(String(theCase.patient), 'kidney', { kinds: ['kidney'] });
  }
}
