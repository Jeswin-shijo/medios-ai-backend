import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import type { Actor } from '../beds/actor';
import { UserRole } from '../users/schemas/user.schema';
import { PharmacyChecksService, WAITING } from './pharmacy-checks.service';
import { LineContext, LineInput, PharmacyOrderView, PharmacyOrdersService, PreviewResult } from './pharmacy-orders.service';
import { PharmacyLine, PharmacyLineDocument } from './schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderDocument } from './schemas/pharmacy-order.schema';

/** Who Pharmacy acts as when it cancels lines for the Discharge Agent. */
export const DISCHARGE_AGENT_ACTOR: Actor = { id: 'discharge-agent', name: 'Discharge Agent', role: UserRole.ADMIN };

export const TAKE_HOME_NOTE = 'Take-home medicines';

/**
 * The medicines a patient leaves with (A3, A12), for the Discharge Agent. A take-home order is an ordinary Ward
 * order made through `PharmacyOrdersService.order` (the same allergy refusal, recheck, announce and To check), marked
 * take-home, so a line that carries a ward medicine on at home reads "Continues ward medicine", not a red double.
 */
@Injectable()
export class PharmacyTakeHomeService {
  constructor(
    private readonly orders: PharmacyOrdersService,
    private readonly checks: PharmacyChecksService,
    @InjectModel(PharmacyOrder.name) private readonly orderDocs: Model<PharmacyOrderDocument>,
    @InjectModel(PharmacyLine.name) private readonly lines: Model<PharmacyLineDocument>,
  ) {}

  /** The live safety flags of take-home lines on the case, without saving anything (as `preview`). */
  check(input: { patientId: string; caseId: string; lines: LineInput[] }): Promise<PreviewResult> {
    return this.orders.preview({ patientId: input.patientId, lines: input.lines }, this.context(input.caseId));
  }

  /** Places the take-home order on the case: Ward, urgent, with the planned leaving time (clinic clock). */
  async place(actor: Actor, input: { patientId: string; caseId: string; plannedLeaveAt: Date; lines: LineInput[] }): Promise<PharmacyOrderView> {
    const at = input.plannedLeaveAt;
    if (!(at instanceof Date) || isNaN(at.getTime())) throw new BadRequestException('plannedLeaveAt must be a valid date');
    return this.orders.order(
      actor,
      { patientId: input.patientId, priority: 'urgent', note: TAKE_HOME_NOTE, lines: input.lines },
      { setting: 'Ward', takeHome: true, plannedLeaveAt: at, caseId: String(input.caseId) },
    );
  }

  /**
   * Cancels a take-home order's waiting lines (to-check, query, approved) as the Discharge Agent; issued lines stay.
   * Any other order is never touched. Returns how many it cancelled.
   */
  async cancelOrder(orderId: string, reason: string): Promise<number> {
    if (!isValidObjectId(orderId) || !(await this.orderDocs.exists({ _id: orderId, takeHome: true }).exec())) return 0;
    const waiting = await this.lines.find({ order: orderId, status: { $in: WAITING } }).sort({ _id: 1 }).select('_id').lean().exec();
    return this.checks.cancelWaiting(DISCHARGE_AGENT_ACTOR, waiting.map((l) => String(l._id)), reason);
  }

  private context(caseId: string): LineContext {
    return { caseId: String(caseId), setting: 'Ward', takeHome: true };
  }
}
