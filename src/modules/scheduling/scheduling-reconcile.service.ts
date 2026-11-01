import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { clinicNow, isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import { SchedulingConflictsService } from './scheduling-conflicts.service';
import { SchedulingConsultsService } from './scheduling-consults.service';
import { SchedulingProceduresService } from './scheduling-procedures.service';
import { SchedulingWaitlistService } from './scheduling-waitlist.service';
import { ConsultRequest, ConsultRequestDocument } from './schemas/consult-request.schema';
import { ProcedureBooking, ProcedureBookingDocument } from './schemas/procedure-booking.schema';
import { WaitItem, WaitItemDocument } from './schemas/wait-item.schema';

/** Records younger than this are left alone: the request that made them may still be finishing its own messages and alerts. */
export const RECONCILE_GRACE_MS = 30_000;
/** Messages are re-sent only for records changed within this long (Z29). */
export const RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface ReconcileResult {
  announced: number;
  alerts: number;
  waitItems: number;
  booked: number;
  conflicts: number;
}

/**
 * Repairs what a failed send or a crash left undone, then runs the agent's periodic work. Every step is idempotent, and
 * a step that fails is logged and does not stop the next. The one-minute scheduler (Task 13) calls reconcile().
 */
@Injectable()
export class SchedulingReconcileService {
  private readonly logger = new Logger(SchedulingReconcileService.name);

  constructor(
    @InjectModel(ProcedureBooking.name) private readonly bookings: Model<ProcedureBookingDocument>,
    @InjectModel(ConsultRequest.name) private readonly consults: Model<ConsultRequestDocument>,
    @InjectModel(WaitItem.name) private readonly waitItems: Model<WaitItemDocument>,
    private readonly procedures: SchedulingProceduresService,
    private readonly consultsService: SchedulingConsultsService,
    private readonly waitlist: SchedulingWaitlistService,
    private readonly conflicts: SchedulingConflictsService,
  ) {}

  async reconcile(): Promise<ReconcileResult> {
    const old = new Date(Date.now() - RECONCILE_GRACE_MS);
    const since = new Date(Date.now() - RECONCILE_WINDOW_MS);
    const out: ReconcileResult = { announced: 0, alerts: 0, waitItems: 0, booked: 0, conflicts: 0 };
    await this.step('procedure messages', async () => (out.announced += await this.reannounceBookings(old, since)));
    await this.step('consult messages', async () => (out.announced += await this.reannounceConsults(old, since)));
    await this.step('procedure alerts', async () => (out.alerts += await this.restoreBookingAlerts(old)));
    await this.step('consult alerts', async () => (out.alerts += await this.restoreConsultAlerts(old)));
    await this.step('wait items', async () => (out.waitItems += await this.settleWaitItems(old)));
    await this.step('waiting procedures', async () => (out.booked += await this.procedures.retryWaiting()));
    await this.step('waitlist ageing', async () => void (await this.waitlist.ageAlerts()));
    await this.step('conflicts', async () => (out.conflicts += (await this.conflicts.sweep()).length));
    return out;
  }

  private async step(what: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (e) {
      this.logger.error(`Reconcile: ${what} failed: ${(e as Error).message}`);
    }
  }

  /** Procedures whose message for the current status never went out. */
  private async reannounceBookings(old: Date, since: Date): Promise<number> {
    const missing = await this.bookings.find({ announcedAt: { $exists: false }, updatedAt: { $lte: old, $gte: since } }).select('_id').sort({ createdAt: 1 }).lean().exec();
    let n = 0;
    for (const b of missing) if (await this.procedures.reannounce(String(b._id))) n++;
    return n;
  }

  /** Consults whose message for the current status never went out. */
  private async reannounceConsults(old: Date, since: Date): Promise<number> {
    const missing = await this.consults.find({ announcedAt: { $exists: false }, updatedAt: { $lte: old, $gte: since } }).select('_id').sort({ createdAt: 1 }).lean().exec();
    let n = 0;
    for (const c of missing) if (await this.consultsService.announce(String(c._id))) n++;
    return n;
  }

  /** Team notices of booked procedures and "Can't book yet" alerts: written when missing, never reopened. */
  private async restoreBookingAlerts(old: Date): Promise<number> {
    // Booked ones from today on (the clinic day's midnight), and every case waiting for a room.
    const midnight = parseIsoDay(isoDate(clinicNow()));
    const live = await this.bookings
      .find({ updatedAt: { $lte: old }, $or: [{ status: 'booked', start: { $gte: midnight } }, { status: 'cant-book' }] })
      .select('_id status')
      .lean()
      .exec();
    let n = 0;
    for (const b of live) n += b.status === 'booked' ? await this.procedures.raiseTeamAlerts(String(b._id), true) : await this.procedures.raiseWaitAlert(String(b._id), true);
    return n;
  }

  /** Page alerts of consults still open. Returns how many were written. */
  private async restoreConsultAlerts(old: Date): Promise<number> {
    const open = await this.consults.find({ status: { $in: ['paged', 'accepted'] }, updatedAt: { $lte: old } }).select('_id').lean().exec();
    let n = 0;
    for (const c of open) if (await this.consultsService.ensureAlert(String(c._id))) n++;
    return n;
  }

  /**
   * An open procedure wait item whose booking has moved on (booked, started or done: resolved; cancelled: cancelled).
   * This covers "Book offered" failing to book while the pass booked it later.
   */
  private async settleWaitItems(old: Date): Promise<number> {
    const open = await this.waitItems.find({ kind: 'procedure', status: 'open', updatedAt: { $lte: old } }).select('_id refId').lean().exec();
    if (!open.length) return 0;
    const state = new Map((await this.bookings.find({ _id: { $in: open.map((w) => w.refId) } }).select('status').lean().exec()).map((b) => [String(b._id), b.status]));
    let n = 0;
    for (const w of open) {
      const status = state.get(String(w.refId));
      const to = status === 'cancelled' ? 'cancelled' : status === 'booked' || status === 'in-progress' || status === 'done' ? 'resolved' : null;
      if (!to) continue;
      if (await this.waitlist.settle(String(w._id), to)) n++;
    }
    return n;
  }
}
