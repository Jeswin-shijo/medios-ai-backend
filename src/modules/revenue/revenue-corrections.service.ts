import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { formatRupees } from '../../common/utils/money';
import type { Actor } from '../beds/actor';
import { ApprovalsService } from '../coordinator/approvals.service';
import { UserRole } from '../users/schemas/user.schema';
import { PriceListService } from './price-list.service';
import { PRICE_CATEGORIES, PriceCategory } from './revenue-catalogue';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueCaptureService, SuggestedReversal } from './revenue-capture.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { FinalBillService } from './revenue-final.service';
import { BillDocument } from './schemas/bill.schema';
import { ChargeLine, ChargeLineDocument, LineCategory } from './schemas/charge-line.schema';
import { CORRECTION_KINDS, Correction, CorrectionDocument, CorrectionKind } from './schemas/correction.schema';

export interface CorrectionInput {
  billId: string;
  lineId?: string;
  kind: CorrectionKind;
  amount?: number;
  qty?: number;
  unitPrice?: number;
  percent?: number;
  reason: string;
}

export interface MissedChargeInput {
  code?: string;
  name?: string;
  category: PriceCategory;
  qty: number;
  unitPrice?: number;
  reason: string;
}

const MAX_MONEY = 10_000_000;
const AGENT: { id: string; name: string } = { id: 'revenue-agent', name: 'Revenue Agent' };
const sourceOf = (id: unknown) => ({ 'source.type': 'correction', 'source.ref': String(id) });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

interface Computed {
  /** Signed amount of the line written (negative takes money off). */
  delta: number;
  category: LineCategory;
  name: string;
  field: 'charges' | 'discounts';
}

/**
 * Money changes on a bill: missed charges, reversals, price changes, discounts and write-offs. Everything except a missed
 * charge waits for an admin (an admin's own request applies at once). A charge line is never edited: each change is a
 * separate credit or adjustment line, written exactly once.
 */
@Injectable()
export class CorrectionsService {
  private readonly logger = new Logger(CorrectionsService.name);

  constructor(
    registration: RevenueCoordinatorRegistration,
    private readonly bills: RevenueBillsService,
    private readonly approvals: ApprovalsService,
    private readonly final: FinalBillService,
    private readonly prices: PriceListService,
    capture: Pick<RevenueCaptureService, 'onSuggestedReversal'>,
    @InjectModel(Correction.name) private readonly corrections: Model<CorrectionDocument>,
    @InjectModel(ChargeLine.name) private readonly lines: Model<ChargeLineDocument>,
  ) {
    registration.onCorrectionDecision.push((id, decision, actor) => this.decided(id, decision, actor));
    capture.onSuggestedReversal.push((e) => this.suggest(e));
  }

  private desk(actor: Actor) {
    if (!actor || (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF)) throw new ForbiddenException('Only the billing desk or an admin can change a bill');
  }

  private reasonOf(reason: unknown): string {
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (!why) throw new BadRequestException('Say why');
    if (why.length > 300) throw new BadRequestException('The reason is too long (300 characters at most)');
    return why;
  }

  /** A charge the desk forgot to bill. A price-list code fills the name and price. Allowed on an open or final bill. */
  async addMissed(actor: Actor, billId: string, input: MissedChargeInput) {
    this.desk(actor);
    const reason = this.reasonOf(input.reason);
    if (!PRICE_CATEGORIES.includes(input.category)) throw new BadRequestException('Choose a category');
    let name = (input.name ?? '').trim();
    let unitPrice = input.unitPrice;
    const code = (input.code ?? '').trim();
    if (code) {
      const found = await this.prices.priceFor(code);
      if (found.needsPrice && unitPrice === undefined) throw new BadRequestException(`"${code}" is not in the price list or has no price; enter the price`);
      if (!name) name = found.name;
      if (unitPrice === undefined) unitPrice = found.price;
    }
    if (!name) throw new BadRequestException('Name the charge');
    if (unitPrice === undefined || !Number.isInteger(unitPrice) || unitPrice < 0 || unitPrice > MAX_MONEY) throw new BadRequestException('The price must be whole rupees');
    const { line } = await this.bills.addCharge(billId, {
      code: code || 'other:manual',
      name: name.slice(0, 120),
      category: input.category,
      qty: input.qty,
      unitPrice,
      source: { type: 'manual', ref: String(new Types.ObjectId()) },
      reason,
      by: { id: actor.id, name: actor.name },
    });
    return line;
  }

  /** The Revenue agent's own suggestion (a lab test cancelled after it was charged). Never applied without an admin. */
  private async suggest(e: SuggestedReversal): Promise<void> {
    await this.request('agent', { billId: e.billId, lineId: e.lineId, kind: 'reversal', reason: e.reason });
  }

  /**
   * Asks for a change. Returns the correction: `pending` with an approval, or (an admin's own request) already applied.
   * The agent's request returns null when there is nothing to suggest (a bill settled, a line already handled).
   */
  async request(actor: Actor | 'agent', input: CorrectionInput): Promise<CorrectionDocument | null> {
    const agent = actor === 'agent';
    if (!agent) this.desk(actor);
    if (!CORRECTION_KINDS.includes(input.kind)) throw new BadRequestException('Unknown correction kind');
    const reason = this.reasonOf(input.reason);
    const bill = await this.bills.get(input.billId);
    if (bill.state === 'settled') {
      if (agent) return null;
      throw new ConflictException('This bill is settled');
    }
    const money = (v: unknown, what: string) => {
      if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > MAX_MONEY) throw new BadRequestException(`${what} must be whole rupees, 1 or more`);
    };
    let lineId: Types.ObjectId | undefined;
    if (input.kind === 'reversal' || input.kind === 'change' || (input.kind === 'discount' && input.lineId)) {
      if (!input.lineId || !isValidObjectId(input.lineId)) throw new BadRequestException('Choose the charge line');
      lineId = new Types.ObjectId(input.lineId);
      const line = await this.lines.findOne({ _id: lineId, bill: bill._id }).lean().exec();
      if (!line) throw new NotFoundException('Charge line not found on this bill');
      if (line.source.type === 'correction') throw new BadRequestException('A correction line cannot be corrected');
      if (line.reversed && input.kind !== 'discount') {
        if (agent) return null;
        throw new ConflictException('This line is already reversed');
      }
    }
    const data: Partial<Correction> = {};
    switch (input.kind) {
      case 'change': {
        if (input.qty === undefined && input.unitPrice === undefined) throw new BadRequestException('Give the new quantity or price');
        if (input.qty !== undefined) {
          if (!Number.isInteger(input.qty) || input.qty < 1) throw new BadRequestException('Quantity must be a whole number, 1 or more');
          data.qty = input.qty;
        }
        if (input.unitPrice !== undefined) {
          if (!Number.isInteger(input.unitPrice) || input.unitPrice < 0 || input.unitPrice > MAX_MONEY) throw new BadRequestException('The price must be whole rupees');
          data.unitPrice = input.unitPrice;
        }
        break;
      }
      case 'discount': {
        if ((input.amount === undefined) === (input.percent === undefined)) throw new BadRequestException('Give an amount or a percent, not both');
        if (input.amount !== undefined) {
          money(input.amount, 'The discount');
          data.amount = input.amount;
        } else {
          if (!Number.isInteger(input.percent) || (input.percent as number) < 1 || (input.percent as number) > 100) throw new BadRequestException('The percent must be a whole number from 1 to 100');
          data.percent = input.percent;
        }
        break;
      }
      case 'writeoff': {
        money(input.amount, 'The write-off');
        data.amount = input.amount;
        if ((bill.kind === 'er' || bill.kind === 'admission') && bill.state !== 'final') throw new ConflictException('Prepare the final bill first');
        if ((bill.totals?.balance ?? 0) <= 0) throw new ConflictException('Nothing is left to write off');
        break;
      }
      default:
        break;
    }
    if (agent && lineId) {
      // R19: the agent suggests a reversal once per charge line, even when the message is replayed (a rejected one is not suggested again).
      const earlier = await this.corrections.findOne({ line: lineId, kind: 'reversal', suggested: true, state: { $ne: 'void' } }).exec();
      if (earlier) return null;
    }
    let created: CorrectionDocument;
    try {
      created = await this.corrections.create({
        bill: bill._id,
        ...(lineId ? { line: lineId } : {}),
        kind: input.kind,
        ...data,
        reason,
        requestedBy: agent ? AGENT : { id: actor.id, name: actor.name },
        state: 'pending',
        suggested: agent,
      });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        if (agent) return null;
        throw new ConflictException('A correction for this line is already waiting');
      }
      throw e;
    }
    // A settle that ran between the check above and the insert wins: the correction is withdrawn.
    const again = await this.bills.get(input.billId);
    if (again.state === 'settled') {
      await this.corrections.deleteOne({ _id: created._id }).exec();
      if (agent) return null;
      throw new ConflictException('This bill is settled');
    }
    if (!agent && actor.role === UserRole.ADMIN) {
      return this.apply(String(created._id), actor);
    }
    try {
      const approval = await this.approvals.request({
        type: 'revenue.correction',
        case: bill.case ? String(bill.case) : null,
        summary: this.summaryOf(bill, created),
        source: { kind: 'revenue-correction', id: String(created._id) },
      });
      created.approvalId = approval._id as Types.ObjectId;
      await this.corrections.updateOne({ _id: created._id }, { $set: { approvalId: approval._id } }).exec();
    } catch (e) {
      await this.corrections.deleteOne({ _id: created._id }).exec();
      throw e;
    }
    return created;
  }

  private summaryOf(bill: BillDocument, c: CorrectionDocument): string {
    const money = c.amount !== undefined ? ` ${formatRupees(c.amount)}` : c.percent !== undefined ? ` ${c.percent}%` : '';
    const label = { change: 'Change a charge', reversal: 'Reverse a charge', discount: 'Discount', writeoff: 'Write-off' }[c.kind];
    return `${bill.number}: ${label}${money}`;
  }

  /** The approval listener: ours are found by their approval. Rejections are recorded and nothing changes. */
  private async decided(approvalId: string, decision: 'approved' | 'rejected', actor: Actor): Promise<void> {
    if (!isValidObjectId(approvalId)) return;
    const c = await this.corrections.findOne({ approvalId: new Types.ObjectId(approvalId) }).exec();
    if (!c) return;
    if (decision === 'rejected') {
      await this.corrections.updateOne({ _id: c._id, state: 'pending' }, { $set: { state: 'rejected', decidedBy: { id: actor.id, name: actor.name } } }).exec();
      return;
    }
    await this.apply(String(c._id), actor);
  }

  /**
   * Applies an approved correction exactly once. The claim (`pending` to `approved`) is one guarded write; the credit line
   * is unique per correction, and only its creator moves the totals, so a retry after a throw finishes the rest without
   * moving the money again. A bill that settled meanwhile voids the correction (no throw, so the approval does not reopen).
   */
  async apply(correctionId: string, actor?: Actor): Promise<CorrectionDocument> {
    if (!isValidObjectId(correctionId)) throw new NotFoundException('Correction not found');
    const id = new Types.ObjectId(correctionId);
    const decidedBy = actor ? { id: actor.id, name: actor.name } : undefined;
    let c = await this.corrections.findOneAndUpdate({ _id: id, state: 'pending' }, { $set: { state: 'approved', ...(decidedBy ? { decidedBy } : {}) } }, { new: true }).exec();
    if (!c) {
      const found = await this.corrections.findById(id).exec();
      if (!found) throw new NotFoundException('Correction not found');
      // Rejected, void or already applied: nothing to do. Approved but not finished: resume.
      if (found.state !== 'approved' || found.appliedAt) return found;
      c = found;
    }
    const billId = String(c.bill);
    let line = await this.lines.findOne(sourceOf(c._id)).exec();
    let delta = line?.amount ?? 0;
    let field: 'charges' | 'discounts' = 'charges';
    let after: BillDocument | null = null;
    if (!line) {
      const bill = await this.bills.get(billId);
      const computed = bill.state === 'settled' ? 'This bill is settled' : await this.compute(c, bill);
      if (typeof computed === 'string') return this.void(c, computed);
      ({ delta, field } = computed);
      let made = false;
      try {
        line = await this.lines.create({
          bill: c.bill,
          code: `correction:${c.kind}`,
          name: computed.name,
          category: computed.category,
          qty: 1,
          unitPrice: delta,
          amount: delta,
          source: { type: 'correction', ref: String(c._id) },
          chargedAt: clinicNow(),
          by: c.decidedBy ?? c.requestedBy,
          reason: c.reason,
        });
        made = true;
      } catch (e) {
        // Another pass wrote the line first: it moves the totals; this one only finishes.
        if ((e as { code?: number }).code !== 11000) throw e;
      }
      if (made && line) {
        try {
          after = await this.bills.adjust(billId, field === 'charges' ? { charges: delta } : { discounts: -delta }, { onlyActive: true });
        } catch (e) {
          await this.lines.deleteOne({ _id: line._id }).exec();
          if (e instanceof ConflictException) return this.void(c, 'The bill was settled before this could be applied');
          throw e;
        }
      }
    }
    if (c.line) {
      await this.lines.updateOne({ _id: c.line }, { $addToSet: { corrections: c._id }, ...(c.kind === 'reversal' ? { $set: { reversed: true } } : {}) }).exec();
    }
    const done = await this.corrections.findOneAndUpdate({ _id: c._id, state: 'approved' }, { $set: { appliedAt: new Date(), delta } }, { new: true }).exec();
    // R22: a write-off that brings the balance to 0 settles the bill, through the guarded settle. A failure is logged, not thrown.
    if (c.kind === 'writeoff') {
      const bill = after ?? (await this.bills.get(billId));
      if ((bill.totals?.balance ?? 0) === 0 && bill.state !== 'settled') {
        try {
          await this.final.settle('agent', billId);
        } catch (e) {
          this.logger.warn(`Write-off applied but bill ${bill.number} did not settle (${(e as Error).message})`);
        }
      }
    }
    return done ?? c;
  }

  private async void(c: CorrectionDocument, why: string): Promise<CorrectionDocument> {
    const v = await this.corrections.findOneAndUpdate({ _id: c._id, state: 'approved', appliedAt: null }, { $set: { state: 'void', voidReason: why } }, { new: true }).exec();
    return v ?? c;
  }

  /** What the credit or adjustment line should be, from the money as it is now; a string means "cannot apply" (the reason). */
  private async compute(c: CorrectionDocument, bill: BillDocument): Promise<Computed | string> {
    let line: ChargeLineDocument | null = null;
    let charge = 0;
    let discounted = 0;
    if (c.line) {
      line = await this.lines.findById(c.line).exec();
      if (!line) return 'The charge line is gone';
      const prior = await this.corrections.find({ line: c.line, state: 'approved', appliedAt: { $ne: null }, _id: { $ne: c._id } }).lean().exec();
      charge = line.amount + sum(prior.filter((p) => p.kind === 'change' || p.kind === 'reversal').map((p) => p.delta ?? 0));
      discounted = sum(prior.filter((p) => p.kind === 'discount').map((p) => -(p.delta ?? 0)));
    }
    switch (c.kind) {
      case 'reversal':
        if (line!.reversed || charge <= 0) return 'The charge is already reversed';
        return { delta: -charge, category: line!.category, name: `Reversal: ${line!.name}`.slice(0, 120), field: 'charges' };
      case 'change': {
        const now = (c.qty ?? line!.qty) * (c.unitPrice ?? line!.unitPrice);
        if (line!.reversed) return 'The charge is already reversed';
        if (now === charge) return 'The new amount is the same as the old one';
        return { delta: now - charge, category: line!.category, name: `Correction: ${line!.name}`.slice(0, 120), field: 'charges' };
      }
      case 'discount': {
        const base = line ? charge - discounted : (bill.totals?.charges ?? 0) - (bill.totals?.discounts ?? 0);
        const amount = c.amount ?? Math.round((base * (c.percent ?? 0)) / 100);
        if (amount < 1 || amount > base) return 'The discount is more than what is left to charge';
        return { delta: -amount, category: 'discount', name: line ? `Discount: ${line.name}`.slice(0, 120) : 'Discount', field: 'discounts' };
      }
      default: {
        // A write-off is of the unpaid balance (R22): never more than it is now.
        const balance = bill.totals?.balance ?? 0;
        if (balance <= 0) return 'Nothing is left to write off';
        return { delta: -Math.min(c.amount ?? 0, balance), category: 'write-off', name: 'Write-off', field: 'discounts' };
      }
    }
  }
}
