import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(PharmacyTakeHomeService.name);

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

  /**
   * Places the take-home order on the case: Ward, urgent, with the planned leaving time (clinic clock). `dueFrom` (real
   * time) is the start of the discharge window: no check or issue of this order is due before it (B3-I2), so an
   * evening order for tomorrow pages nobody overnight. Without it the urgent targets apply as for any ward order.
   */
  async place(actor: Actor, input: { patientId: string; caseId: string; plannedLeaveAt: Date; lines: LineInput[]; dueFrom?: Date }): Promise<PharmacyOrderView> {
    const at = input.plannedLeaveAt;
    if (!(at instanceof Date) || isNaN(at.getTime())) throw new BadRequestException('plannedLeaveAt must be a valid date');
    const from = input.dueFrom instanceof Date && !isNaN(input.dueFrom.getTime()) ? input.dueFrom : undefined;
    return this.orders.order(
      actor,
      { patientId: input.patientId, priority: 'urgent', note: TAKE_HOME_NOTE, lines: input.lines },
      { setting: 'Ward', takeHome: true, plannedLeaveAt: at, caseId: String(input.caseId), ...(from ? { dueFrom: from } : {}) },
    );
  }

  /**
   * The doctor moved the planned leaving time (B1-M9, B3-I2): each take-home order among `orderIds` takes the new time
   * (clinic clock) and the new `dueFrom` (real time; unset when not given), its open rounds are re-synced, and the start
   * message of each round whose due time moved goes again under its own key, so the running clock moves with it. Any
   * other order is never touched. Returns how many orders it changed. Never throws: a failure is logged.
   */
  async setPlannedLeave(orderIds: string[], at: Date, dueFrom?: Date): Promise<number> {
    if (!(at instanceof Date) || isNaN(at.getTime())) return 0;
    const from = dueFrom instanceof Date && !isNaN(dueFrom.getTime()) ? dueFrom : null;
    let changed = 0;
    for (const id of [...new Set(orderIds.map(String))].filter((x) => isValidObjectId(x))) {
      try {
        const before = await this.orderDocs
          .findOneAndUpdate(
            { _id: id, takeHome: true },
            from ? { $set: { plannedLeaveAt: at, dueFrom: from } } : { $set: { plannedLeaveAt: at }, $unset: { dueFrom: 1 } },
          )
          .lean<{ checkDueAt?: Date; issueDueAt?: Date }>()
          .exec();
        if (!before) continue;
        changed += 1;
        await this.orders.syncRounds(id);
        const after = await this.orderDocs.findById(id).select('checkOpen checkDueAt issueOpen issueDueAt').lean<PharmacyOrder>().exec();
        const tag = `leave:${at.getTime()}:${Date.now()}`;
        for (const clock of ['check', 'issue'] as const) {
          const was = before[`${clock}DueAt`];
          const now = after?.[`${clock}DueAt`];
          if (!after?.[`${clock}Open`] || !now || (was && new Date(was).getTime() === new Date(now).getTime())) continue;
          await this.orders.resendStart(id, clock, tag);
        }
      } catch (e) {
        this.logger.warn(`Take-home order ${id}: the planned leaving time was not moved (${(e as Error).message})`);
      }
    }
    return changed;
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
