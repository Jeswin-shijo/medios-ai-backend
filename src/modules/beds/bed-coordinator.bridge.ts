import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Subscription } from 'rxjs';
import { clinicNow } from '../../common/utils/clinic-time';
import { AgentRegistry } from '../coordinator/agent-registry';
import { ApprovalsService } from '../coordinator/approvals.service';
import { CasesService } from '../coordinator/cases.service';
import { AgentDefinition, CloseCheckResult, MessageTypeDef, Priority } from '../coordinator/coordinator-types';
import { MessagesService } from '../coordinator/messages.service';
import { UserRole } from '../users/schemas/user.schema';
import { BedChange, BedEvents, BedRequestEvent } from './bed-events';
import { BedRequestsService, BedRequestView } from './bed-requests.service';
import { Admission, AdmissionDocument } from './schemas/admission.schema';
import { BedRequest, BedRequestDocument } from './schemas/bed-request.schema';

const CAPACITY = 20;
const ON_TIME_MINUTES = 15;
const DAY_MS = 24 * 60 * 60_000;
const BED_WAIT_MINUTES = 60;

const type = (t: string, description: string, payload: MessageTypeDef['payload']): MessageTypeDef => ({
  type: t,
  agent: 'bed',
  description,
  payload,
});

const MESSAGE_TYPES: MessageTypeDef[] = [
  type('bed.request', 'A bed was requested for a patient', { requestId: 'string', requestType: 'string', priority: 'string' }),
  type('bed.assigned', 'A patient was placed in a bed', { bedId: 'string', bedLabel: 'string', admissionId: 'string' }),
  type('bed.waiting', 'No bed fits yet; the request waits', { requestId: 'string' }),
  type('bed.attention', 'A bed request needs a person to decide', { requestId: 'string' }),
  type('bed.cancelled', 'A bed request was cancelled', { requestId: 'string' }),
  type('bed.transferred', 'A patient moved to another bed', { bedId: 'string', bedLabel: 'string', fromBedLabel: 'string', admissionId: 'string' }),
  type('bed.discharged', 'A patient left a bed', { bedId: 'string', bedLabel: 'string' }),
  type('bed.cleaned', 'A bed was cleaned and is free again', { bedId: 'string', bedLabel: 'string' }),
];

/**
 * Reports what the Bed Agent does to the Coordinator, so bed work shows up in cases, the
 * message log, clocks, approvals and escalations. Summaries and payloads carry the UHID and
 * bed label, never the patient's name. Every handler catches its own errors: a report that
 * fails must never break a bed action.
 */
@Injectable()
export class BedCoordinatorBridge implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BedCoordinatorBridge.name);
  private readonly subscriptions: Subscription[] = [];
  /** Events are handled one at a time, in the order they happened (assigned needs bed.request first). */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly events: BedEvents,
    private readonly requests: BedRequestsService,
    private readonly registry: AgentRegistry,
    private readonly messages: MessagesService,
    private readonly cases: CasesService,
    private readonly approvals: ApprovalsService,
    @InjectModel(Admission.name) private readonly admissions: Model<AdmissionDocument>,
    @InjectModel(BedRequest.name) private readonly requestModel: Model<BedRequestDocument>,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.definition());
    this.subscriptions.push(
      this.events.requests$.subscribe((e) => this.enqueue('request', () => this.onRequest(e))),
      this.events.bedChanges$.subscribe((c) => this.enqueue('bed change', () => this.onBedChange(c))),
    );
  }

  onModuleDestroy(): void {
    for (const s of this.subscriptions) s.unsubscribe();
  }

  /** Resolves when every event seen so far has been handled. */
  idle(): Promise<void> {
    return this.queue;
  }

  private enqueue(what: string, work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((e) => this.logger.error(`Reporting a bed ${what} to the Coordinator failed: ${(e as Error).message}`));
  }

  private definition(): AgentDefinition {
    return {
      key: 'bed',
      messageTypes: MESSAGE_TYPES,
      clocks: [
        {
          key: 'bed-wait',
          agent: 'bed',
          label: 'Bed wait',
          startOn: 'bed.waiting',
          stopOn: ['bed.assigned', 'bed.cancelled'],
          minutes: BED_WAIT_MINUTES,
          ladder: 'bed-wait',
        },
      ],
      approvalTypes: [{ type: 'bed.attention', agent: 'bed', roles: [UserRole.ADMIN, UserRole.DOCTOR], primary: { kind: 'open', label: 'Open' } }],
      closeChecks: [{ agent: 'bed', label: 'Admission discharged or request cancelled', check: (caseId) => this.closeCheck(caseId) }],
      requestTypes: [{ key: 'bed-request', label: 'Bed allocation request', agent: 'bed' }],
      rules: [
        {
          key: 'bed-auto-allocate',
          agent: 'bed',
          label: 'Bed availability matching',
          description: 'Auto-check and allocate the best available bed',
          default: true,
          settingPath: 'ai.bedAutoAllocate',
        },
      ],
      status: () => this.status(),
    };
  }

  /**
   * With an admission: it is discharged. Without: every bed request on the case was cancelled and
   * the patient has no active admission (an assigned request, or a staff placement that beat it,
   * means the admission ref is on its way). No refs at all: 'n/a', the Bed Agent has no say.
   */
  private async closeCheck(caseId: string): Promise<CloseCheckResult> {
    const c = await this.cases.get(caseId);
    if (!c) return 'fail';
    const { admissionId, bedRequestIds } = c.refs;
    if (admissionId) {
      const admission = await this.admissions.findById(admissionId).select('status').lean<{ status: string }>().exec();
      return admission?.status === 'discharged' ? 'pass' : 'fail';
    }
    if (!bedRequestIds?.length) return 'n/a';
    const notCancelled = await this.requestModel.countDocuments({ _id: { $in: bedRequestIds }, state: { $ne: 'cancelled' } }).exec();
    if (notCancelled > 0) return 'fail';
    return (await this.admissions.exists({ patient: c.patient, status: 'active' }).exec()) ? 'fail' : 'pass';
  }

  private async status() {
    const open = await this.requests.countOpen();
    const since = new Date(clinicNow().getTime() - DAY_MS);
    const recent = await this.requestModel
      .find({ requestedAt: { $gte: since } })
      .select('requestedAt assignedAt')
      .lean<{ requestedAt: Date; assignedAt?: Date }[]>()
      .exec();
    const onTime = recent.filter((r) => r.assignedAt && r.assignedAt.getTime() - r.requestedAt.getTime() <= ON_TIME_MINUTES * 60_000).length;
    return { open, capacity: CAPACITY, onTimePct: recent.length ? Math.round((onTime / recent.length) * 100) : null };
  }

  /** The patient's open case, or null: used to log a bed change without opening a case for it. */
  private async openCaseOf(patientId?: string): Promise<string | null> {
    if (!patientId) return null;
    const c = await this.cases.forPatient(patientId);
    return c?.state === 'open' ? String(c._id) : null;
  }

  private async onRequest(e: BedRequestEvent): Promise<void> {
    const r = await this.requests.get(e.id);
    const { case: c } = await this.cases.openOrJoin({
      patientId: r.patientId,
      patientUhid: r.patientUhid,
      patientName: r.patientName,
      kind: 'ipd',
      priority: r.priority,
      openedBy: 'bed',
    });
    const caseId = String(c._id);
    await this.cases.addRefs(caseId, { bedRequestId: r.id });
    // Decided by the log, not the refs: a send that failed after addRefs is still sent on a replay.
    const first = !(await this.messages.findOne('bed.request', { requestId: r.id }));
    const priority: Priority = r.priority;

    if (first) {
      await this.messages.send({
        case: caseId,
        from: 'bed',
        to: ['coordinator'],
        type: 'bed.request',
        priority,
        summary: `${r.patientUhid}: ${r.type} bed requested (${r.priority})`,
        payload: { requestId: r.id, requestType: r.type, priority: r.priority },
        opensWork: true,
      });
    }

    const source = { kind: 'bed-request', id: r.id };
    switch (e.state) {
      case 'assigned': {
        if (r.admissionId) await this.cases.addRefs(caseId, { admissionId: r.admissionId });
        await this.sendResolving(caseId, r, priority, 'bed.assigned', {
          bedId: r.assignedBedId ?? '',
          bedLabel: r.assignedBedLabel ?? '',
          admissionId: r.admissionId ?? '',
        }, `${r.patientUhid} placed in ${r.assignedBedLabel ?? 'a bed'}`);
        await this.approvals.markDone(source, 'Bed Agent');
        break;
      }
      case 'searching':
        // Back with the agent: a person no longer needs to decide.
        await this.approvals.markDone(source, 'Bed Agent');
        break;
      case 'waiting': {
        await this.approvals.markDone(source, 'Bed Agent');
        // Each retry pass re-announces the wait; log it once per wait.
        const last = await this.messages.findLatest('bed.', { requestId: r.id });
        if (last?.type === 'bed.waiting') break;
        await this.messages.send({
          case: caseId,
          from: 'bed',
          to: ['coordinator'],
          type: 'bed.waiting',
          priority,
          summary: `${r.patientUhid} is waiting for a bed`,
          payload: { requestId: r.id },
        });
        break;
      }
      case 'attention':
        await this.messages.send({
          case: caseId,
          from: 'bed',
          to: ['coordinator'],
          type: 'bed.attention',
          priority,
          summary: `${r.patientUhid}: bed request needs a person`,
          payload: { requestId: r.id },
          needsPerson: true,
        });
        await this.approvals.request({ type: 'bed.attention', case: caseId, summary: `Bed request for ${r.patientUhid} needs a person`, source });
        break;
      case 'cancelled':
        await this.sendResolving(caseId, r, priority, 'bed.cancelled', { requestId: r.id }, `Bed request for ${r.patientUhid} was cancelled`);
        await this.approvals.markDone(source, 'Bed Agent');
        break;
      default:
        break;
    }
  }

  /** Sends a message that answers the request's bed.request work. */
  private async sendResolving(
    caseId: string,
    r: BedRequestView,
    priority: Priority,
    msgType: string,
    payload: Record<string, unknown>,
    summary: string,
  ): Promise<void> {
    const opened = await this.messages.findOne('bed.request', { requestId: r.id });
    await this.messages.send({
      case: caseId,
      from: 'bed',
      to: ['coordinator'],
      type: msgType,
      priority,
      summary,
      payload: { ...payload, requestId: r.id },
      ...(opened ? { resolves: opened.id } : {}),
    });
  }

  /** Puts the admission on the patient's open case (joining it, or opening one if none is open). Sends nothing. */
  private async refAdmission(
    requestId: string,
    patient: { patientId: string; patientUhid: string; patientName: string },
    admissionId: string,
  ): Promise<void> {
    const r = await this.requests.get(requestId).catch(() => null);
    const { case: joined } = await this.cases.openOrJoin({ ...patient, kind: 'ipd', priority: r?.priority ?? 'medium', openedBy: 'bed' });
    await this.cases.addRefs(String(joined._id), { admissionId });
  }

  private async onBedChange(c: BedChange): Promise<void> {
    switch (c.kind) {
      case 'admitted': {
        // The agent's own placements are reported by the request's events.
        if (!c.byStaff || !c.patientId || !c.patientUhid || !c.patientName || !c.admissionId) return;
        if (c.requestId) {
          // A staff placement that answers a request: the request's events send the message, but the
          // case needs the admission now, before the agent can cancel the request as moot.
          await this.refAdmission(c.requestId, { patientId: c.patientId, patientUhid: c.patientUhid, patientName: c.patientName }, c.admissionId);
          return;
        }
        const { case: opened } = await this.cases.openOrJoin({
          patientId: c.patientId,
          patientUhid: c.patientUhid,
          patientName: c.patientName,
          kind: 'ipd',
          priority: 'medium',
          openedBy: 'bed',
        });
        const caseId = String(opened._id);
        await this.cases.addRefs(caseId, { admissionId: c.admissionId });
        await this.messages.send({
          case: caseId,
          from: 'bed',
          to: ['coordinator'],
          type: 'bed.assigned',
          priority: 'medium',
          summary: `${c.patientUhid} admitted to ${c.bedLabel}`,
          payload: { bedId: c.bedId, bedLabel: c.bedLabel, admissionId: c.admissionId },
        });
        return;
      }
      case 'transferred':
        await this.messages.send({
          case: await this.openCaseOf(c.patientId),
          from: 'bed',
          to: ['coordinator'],
          type: 'bed.transferred',
          priority: 'medium',
          summary: `${c.patientUhid ?? 'Patient'} moved from ${c.fromBedLabel ?? 'a bed'} to ${c.bedLabel}`,
          payload: { bedId: c.bedId, bedLabel: c.bedLabel, fromBedLabel: c.fromBedLabel ?? '', admissionId: c.admissionId ?? '' },
        });
        return;
      case 'discharged':
        await this.messages.send({
          case: await this.openCaseOf(c.patientId),
          from: 'bed',
          to: ['coordinator'],
          type: 'bed.discharged',
          priority: 'low',
          summary: `${c.patientUhid ?? 'A patient'} left ${c.bedLabel}`,
          payload: { bedId: c.bedId, bedLabel: c.bedLabel, ...(c.admissionId ? { admissionId: c.admissionId } : {}) },
        });
        return;
      case 'cleaned':
        await this.messages.send({
          case: null,
          from: 'bed',
          to: ['coordinator'],
          type: 'bed.cleaned',
          priority: 'low',
          summary: `${c.bedLabel} cleaned and free`,
          payload: { bedId: c.bedId, bedLabel: c.bedLabel },
        });
        return;
    }
  }
}
