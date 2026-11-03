import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { formatRupees } from '../../common/utils/money';
import type { Actor } from '../beds/actor';
import { ApprovalsService } from '../coordinator/approvals.service';
import { UserRole } from '../users/schemas/user.schema';
import type { PendingApprovalRow } from './revenue-approvals';
import { PriceListService } from './price-list.service';
import { PRICE_CATEGORIES, PriceCategory } from './revenue-catalogue';
import { RevenueBillsService, lineTotals } from './revenue-bills.service';
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
    capture: RevenueCaptureService,
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
      if (line.reversed) {
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
      try {
        return await this.apply(String(created._id), actor);
      } catch (e) {
        // Rolled back to pending with no approval to reopen: withdraw it so it cannot hold the bill.
        await this.corrections.deleteOne({ _id: created._id, state: 'pending' }).exec();
        throw e;
      }
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

  /** Corrections waiting for an admin, newest first, with their bill and line (the Approvals tab). */
  async listPending(): Promise<PendingApprovalRow[]> {
    const rows = await this.corrections.find({ state: 'pending', approvalId: { $exists: true } }).sort({ createdAt: -1, _id: -1 }).lean().exec();
    const out: PendingApprovalRow[] = [];
    for (const c of rows) {
      const bill = await this.bills.get(String(c.bill)).catch(() => null);
      if (!bill) continue;
      const line = c.line ? await this.lines.findById(c.line).lean().exec() : null;
      out.push({
        approvalId: String(c.approvalId),
        type: 'correction',
        kind: c.kind,
        recordId: String(c._id),
        bill: { id: String(bill._id), number: bill.number, kind: bill.kind, patientName: bill.patientName, patientUhid: bill.patientUhid },
        ...(line ? { line: { id: String(line._id), name: line.name, amount: line.amount } } : {}),
        ...(c.amount !== undefined ? { amount: c.amount } : {}),
        ...(c.percent !== undefined ? { percent: c.percent } : {}),
        ...(c.qty !== undefined ? { qty: c.qty } : {}),
        ...(c.unitPrice !== undefined ? { unitPrice: c.unitPrice } : {}),
        reason: c.reason,
        requestedBy: c.requestedBy.name,
        requestedAt: new Date((c as unknown as { createdAt: Date }).createdAt).toISOString(),
      });
    }
    return out;
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
   * Applies an approved correction exactly once. The claim (`pending` to `approved`) is one guarded write; each line is unique
   * per correction and only the call that wrote them moves the totals. If anything after the claim throws, the claim is rolled
   * back (lines removed, totals put back, state `pending` again) before rethrowing, so the reopened approval can be approved
   * again or rejected and nothing is left holding the bill (R24). A bill that settled meanwhile voids the correction (no throw).
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
    try {
      return await this.finish(c);
    } catch (e) {
      await this.rollback(c);
      throw e;
    }
  }

  private linesOf(c: CorrectionDocument) {
    return this.lines.find({ 'source.type': 'correction', 'source.ref': { $regex: `^${String(c._id)}(:|$)` } }).exec();
  }

  /** What a set of correction lines does to the totals: discount and write-off lines move discounts, the rest move charges. */
  private totalsOf(lines: { category: string; amount: number }[]): { charges: number; discounts: number } {
    return lineTotals(lines);
  }

  private async finish(c: CorrectionDocument): Promise<CorrectionDocument> {
    const billId = String(c.bill);
    let after: BillDocument | null = null;
    let delta = 0;
    const existing = await this.linesOf(c);
    if (existing.length) {
      delta = existing.find((l) => l.source.ref === String(c._id))?.amount ?? 0;
    } else {
      const bill = await this.bills.get(billId);
      const computed = bill.state === 'settled' ? 'This bill is settled' : await this.compute(c, bill);
      if (typeof computed === 'string') return this.void(c, computed);
      delta = computed[0].amount;
      const made: ChargeLineDocument[] = [];
      let raced = false;
      try {
        for (const l of computed) {
          made.push(
            await this.lines.create({
              bill: c.bill,
              code: `correction:${c.kind}`,
              name: l.name,
              category: l.category,
              qty: 1,
              unitPrice: l.amount,
              amount: l.amount,
              source: { type: 'correction', ref: l.ref },
              chargedAt: clinicNow(),
              by: c.decidedBy ?? c.requestedBy,
              reason: c.reason,
            }),
          );
        }
      } catch (e) {
        // Another pass wrote the line first: it moves the totals; this one only finishes.
        await this.lines.deleteMany({ _id: { $in: made.map((l) => l._id) } }).exec();
        if ((e as { code?: number }).code !== 11000) throw e;
        raced = true;
      }
      if (!raced) {
        try {
          after = await this.bills.adjust(billId, this.totalsOf(computed), { onlyActive: true });
        } catch (e) {
          await this.lines.deleteMany({ _id: { $in: made.map((l) => l._id) } }).exec();
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

  /** Undoes a failed apply, best effort: totals put back, lines removed, link cleared, state `pending` again. */
  private async rollback(c: CorrectionDocument): Promise<void> {
    const step = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        this.logger.warn(`Correction ${String(c._id)} rollback (${what}) failed: ${(e as Error).message}`);
      }
    };
    const written = await this.linesOf(c).catch(() => [] as ChargeLineDocument[]);
    if (written.length) {
      const t = this.totalsOf(written);
      await step('totals', () => this.bills.adjust(String(c.bill), { charges: -t.charges, discounts: -t.discounts }));
      await step('lines', () => this.lines.deleteMany({ _id: { $in: written.map((l) => l._id) } }).exec());
    }
    if (c.line) await step('link', () => this.lines.updateOne({ _id: c.line }, { $pull: { corrections: c._id }, ...(c.kind === 'reversal' ? { $set: { reversed: false } } : {}) }).exec());
    await step('state', () => this.corrections.updateOne({ _id: c._id, state: 'approved', appliedAt: null }, { $set: { state: 'pending' }, $unset: { decidedBy: 1 } }).exec());
  }

  private async void(c: CorrectionDocument, why: string): Promise<CorrectionDocument> {
    const v = await this.corrections.findOneAndUpdate({ _id: c._id, state: 'approved', appliedAt: null }, { $set: { state: 'void', voidReason: why } }, { new: true }).exec();
    return v ?? c;
  }

  /** The lines to write, from the money as it is now; a string means "cannot apply" (the reason). The first line is the main one. */
  private async compute(c: CorrectionDocument, bill: BillDocument): Promise<{ ref: string; amount: number; category: LineCategory; name: string }[] | string> {
    const ref = String(c._id);
    let line: ChargeLineDocument | null = null;
    let charge = 0;
    let discounted = 0;
    let qty = 0;
    let price = 0;
    if (c.line) {
      line = await this.lines.findById(c.line).exec();
      if (!line) return 'The charge line is gone';
      const prior = await this.corrections.find({ line: c.line, state: 'approved', appliedAt: { $ne: null }, _id: { $ne: c._id } }).sort({ _id: 1 }).lean().exec();
      charge = line.amount;
      qty = line.qty;
      price = line.unitPrice;
      for (const p of prior) {
        if (p.kind === 'change') {
          charge += p.delta ?? 0;
          qty = p.qty ?? qty;
          price = p.unitPrice ?? price;
        } else if (p.kind === 'reversal') charge += p.delta ?? 0;
        else if (p.kind === 'discount') discounted += -(p.delta ?? 0);
      }
    }
    switch (c.kind) {
      case 'reversal': {
        if (line!.reversed || charge <= 0) return 'The charge is already reversed';
        const out = [{ ref, amount: -charge, category: line!.category, name: `Reversal: ${line!.name}`.slice(0, 120) }];
        // R26: the line's own discounts go with it, so it nets to 0 in both charges and discounts.
        if (discounted > 0) out.push({ ref: `${ref}:discount`, amount: discounted, category: 'discount', name: `Discount cancelled: ${line!.name}`.slice(0, 120) });
        return out;
      }
      case 'change': {
        if (line!.reversed) return 'The charge is already reversed';
        const now = (c.qty ?? qty) * (c.unitPrice ?? price);
        if (now === charge) return 'The new amount is the same as the old one';
        return [{ ref, amount: now - charge, category: line!.category, name: `Correction: ${line!.name}`.slice(0, 120) }];
      }
      case 'discount': {
        if (line?.reversed) return 'The charge is already reversed';
        const base = line ? charge - discounted : (bill.totals?.charges ?? 0) - (bill.totals?.discounts ?? 0);
        const amount = c.amount ?? Math.round((base * (c.percent ?? 0)) / 100);
        if (amount < 1 || amount > base) return 'The discount is more than what is left to charge';
        return [{ ref, amount: -amount, category: 'discount', name: line ? `Discount: ${line.name}`.slice(0, 120) : 'Discount' }];
      }
      default: {
        // A write-off is of the unpaid balance (R22): never more than it is now.
        const balance = bill.totals?.balance ?? 0;
        if (balance <= 0) return 'Nothing is left to write off';
        return [{ ref, amount: -Math.min(c.amount ?? 0, balance), category: 'write-off', name: 'Write-off' }];
      }
    }
  }
}
