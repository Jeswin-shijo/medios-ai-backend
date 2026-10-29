import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { CasesService } from '../coordinator/cases.service';
import type { Priority as CasePriority } from '../coordinator/coordinator-types';
import { MessagesService } from '../coordinator/messages.service';
import { CoordinatorCounter, CoordinatorCounterDocument } from '../coordinator/schemas/coordinator-counter.schema';
import { PatientsService } from '../patients/patients.service';
import { UserRole } from '../users/schemas/user.schema';
import { COLLECT_MINUTES, LAB_TESTS, Priority, TUBE_LABEL, groupIntoTubes, targetMinutes, testByKey } from './lab-catalogue';
import { LabSettingsService } from './lab-settings.service';
import { LAB_PRIORITIES, LabRequest, LabRequestDocument } from './schemas/lab-request.schema';
import { LabLine, LabLineDocument, LabLineStatus } from './schemas/lab-line.schema';
import { LabSample, LabSampleDocument } from './schemas/lab-sample.schema';
import { LabArea, LabLocation, LabLocationDocument } from './schemas/lab-location.schema';

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const SUMMARY_MAX = 140;
const CLOSED_LINE: LabLineStatus[] = ['released', 'cancelled'];
const CASE_PRIORITY: Record<Priority, CasePriority> = { stat: 'high', urgent: 'medium', routine: 'low' };

export interface OrderInput {
  patientId: string;
  tests: string[];
  priority: Priority;
  note?: string;
  repeatAfterHours?: number;
}

export interface LabRequestQuery {
  patientId?: string;
  caseId?: string;
  priority?: Priority;
  /** true: not finished yet; false: finished. */
  open?: boolean;
  limit?: number;
}

export interface LabLineView {
  id: string;
  test: string;
  label: string;
  status: LabLineStatus;
  tatDueAt: string;
  results: LabLine['results'];
  version: number;
  enteredAt: string | null;
  releasedAt: string | null;
  cancelled: { by: string; reason: string; at: string } | null;
  critical: { active: boolean; ackBy: string | null; ackAt: string | null; ackNote: string | null } | null;
}

export interface LabSampleView {
  id: string;
  number: string;
  tube: string;
  tubeLabel: string;
  lines: string[];
  status: string;
  collectBy: string;
  collected: { by: string; at: string } | null;
  received: { by: string; at: string } | null;
  rejected: { by: string; reason: string; note: string; at: string } | null;
}

export interface LabRequestView {
  id: string;
  number: string;
  patientId: string;
  patientUhid: string;
  patientName: string;
  caseId: string;
  orderedBy: { id: string; name: string };
  priority: Priority;
  note: string;
  orderedAt: string;
  collectBy: string;
  repeatOf: string | null;
  scheduledFor: string | null;
  location: { area: LabArea; ward?: string };
  lines: LabLineView[];
  samples: LabSampleView[];
  done: boolean;
}

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const earliest = (dates: Date[]) => new Date(Math.min(...dates.map((d) => d.getTime())));
const pad = (n: number, w: number) => String(n).padStart(w, '0');

/** "LR-0001: Complete blood count, Troponin I (STAT)", cut with "+N more" to fit a message summary. */
export function orderSummary(number: string, labels: string[], priority: Priority): string {
  const tail = ` (${priority.toUpperCase()})`;
  const full = `${number}: ${labels.join(', ')}${tail}`;
  if (full.length <= SUMMARY_MAX) return full;
  for (let keep = labels.length - 1; keep >= 1; keep--) {
    const s = `${number}: ${labels.slice(0, keep).join(', ')} +${labels.length - keep} more${tail}`;
    if (s.length <= SUMMARY_MAX) return s;
  }
  return `${number}: ${labels.length} tests${tail}`.slice(0, SUMMARY_MAX);
}

@Injectable()
export class LabOrdersService {
  constructor(
    @InjectModel(LabRequest.name) private readonly requests: Model<LabRequestDocument>,
    @InjectModel(LabLine.name) private readonly lines: Model<LabLineDocument>,
    @InjectModel(LabSample.name) private readonly samples: Model<LabSampleDocument>,
    @InjectModel(LabLocation.name) private readonly locations: Model<LabLocationDocument>,
    @InjectModel(CoordinatorCounter.name) private readonly counters: Model<CoordinatorCounterDocument>,
    private readonly patients: PatientsService,
    private readonly cases: CasesService,
    private readonly messages: MessagesService,
    private readonly labSettings: LabSettingsService,
  ) {}

  // ---------- ordering ----------

  async order(actor: Actor, input: OrderInput): Promise<LabRequestView[]> {
    const tests = input.tests;
    if (!Array.isArray(tests) || tests.length < 1 || tests.length > 10) throw new BadRequestException('Choose 1 to 10 tests');
    if (new Set(tests).size !== tests.length) throw new BadRequestException('Each test can be chosen once');
    for (const t of tests) if (typeof t !== 'string' || !testByKey(t)) throw new BadRequestException(`Unknown test "${String(t)}"`);
    if (!(LAB_PRIORITIES as readonly string[]).includes(input.priority)) throw new BadRequestException('Priority must be stat, urgent or routine');
    const repeat = input.repeatAfterHours;
    if (repeat !== undefined && repeat !== null && (!Number.isInteger(repeat) || repeat < 1 || repeat > 72)) {
      throw new BadRequestException('"repeatAfterHours" must be a whole number from 1 to 72');
    }

    const patient = await this.patients.findOne(String(input.patientId)); // 404 when unknown
    const { case: theCase } = await this.cases.openOrJoin({
      patientId: String(patient._id),
      patientUhid: patient.uhid,
      patientName: patient.name,
      kind: 'opd',
      priority: CASE_PRIORITY[input.priority],
      openedBy: 'lab',
    });

    const base = { patient, caseId: theCase._id as Types.ObjectId, actor, tests, priority: input.priority, note: text(input.note) };
    const first = await this.createRequest({ ...base, at: new Date() });
    const out = [first];
    if (repeat) {
      const scheduledFor = new Date(Date.now() + repeat * HOUR_MS);
      out.push(await this.createRequest({ ...base, at: scheduledFor, scheduledFor, repeatOf: first._id as Types.ObjectId }));
    }
    for (const r of out) await this.announceOrdered(r);
    return this.toViews(await this.requests.find({ _id: { $in: out.map((r) => r._id) } }).sort({ createdAt: 1, _id: 1 }).exec());
  }

  private async createRequest(a: {
    patient: { _id: unknown; uhid: string; name: string };
    caseId: Types.ObjectId;
    actor: Actor;
    tests: string[];
    priority: Priority;
    note: string;
    /** The real moment the work is due from: now, or the schedule of a repeat. */
    at: Date;
    scheduledFor?: Date;
    repeatOf?: Types.ObjectId;
  }): Promise<LabRequestDocument> {
    const collectBy = a.scheduledFor ?? new Date(a.at.getTime() + COLLECT_MINUTES[a.priority] * MIN_MS);
    const request = await this.requests.create({
      number: await this.nextRequestNumber(),
      patient: a.patient._id,
      patientUhid: a.patient.uhid,
      patientName: a.patient.name,
      case: a.caseId,
      orderedBy: { id: a.actor.id, name: a.actor.name },
      priority: a.priority,
      note: a.note,
      orderedAt: clinicNow(),
      collectBy,
      repeatOf: a.repeatOf,
      scheduledFor: a.scheduledFor,
    });
    const lineByTest = new Map<string, Types.ObjectId>();
    const { targets } = await this.labSettings.overrides();
    for (const test of a.tests) {
      const line = await this.lines.create({
        request: request._id,
        test,
        status: 'ordered',
        tatDueAt: new Date(a.at.getTime() + targetMinutes(test, a.priority, targets) * MIN_MS),
      });
      lineByTest.set(test, line._id as Types.ObjectId);
    }
    for (const group of groupIntoTubes(a.tests)) {
      await this.samples.create({
        number: await this.nextSampleNumber(),
        request: request._id,
        tube: group.tube,
        lines: group.tests.map((t) => lineByTest.get(t)),
        status: 'waiting',
        collectBy,
      });
    }
    return request;
  }

  /** Sends lab.ordered for a request the Coordinator has not heard about, then records that it did. */
  private async announceOrdered(request: LabRequestDocument): Promise<void> {
    if (request.announcedAt) return;
    const lines = await this.lines.find({ request: request._id }).sort({ _id: 1 }).exec();
    await this.messages.send({
      case: String(request.case),
      from: 'lab',
      to: ['coordinator'],
      type: 'lab.ordered',
      priority: CASE_PRIORITY[request.priority],
      summary: orderSummary(request.number, lines.map((l) => testByKey(l.test)?.label ?? l.test), request.priority),
      payload: {
        requestId: String(request._id),
        requestNumber: request.number,
        priority: request.priority,
        tests: lines.map((l) => l.test),
        collectBy: request.collectBy,
        tatDueAt: earliest(lines.map((l) => l.tatDueAt)),
      },
    });
    request.announcedAt = new Date();
    await this.requests.updateOne({ _id: request._id }, { announcedAt: request.announcedAt }).exec();
  }

  /**
   * Sends lab.collection-done or lab.request-done and records it. Each send has its own dedupe key,
   * so a second "done" within a minute (after a quick recollection) is not dropped.
   */
  async announceDone(requestId: string | Types.ObjectId, type: 'lab.collection-done' | 'lab.request-done'): Promise<void> {
    const flag = type === 'lab.collection-done' ? 'collectionDoneAt' : 'doneAt';
    // Claim the flag first: of two racing callers only one wins and sends.
    const request = await this.requests.findOneAndUpdate({ _id: requestId, [flag]: { $exists: false } }, { $set: { [flag]: new Date() } }, { new: true }).exec();
    if (!request) {
      if (!(await this.requests.exists({ _id: requestId }).exec())) throw new NotFoundException('Lab request not found');
      return; // already announced
    }
    try {
      await this.messages.send({
        case: String(request.case),
        from: 'lab',
        to: ['coordinator'],
        type,
        priority: CASE_PRIORITY[request.priority],
        summary: `${request.number}: ${type === 'lab.collection-done' ? 'all samples collected' : 'all tests finished'}`,
        payload: { requestId: String(request._id) },
        dedupeKey: `${type}:${request._id}:${new Types.ObjectId()}`,
      });
    } catch (e) {
      await this.requests.updateOne({ _id: request._id }, { $unset: { [flag]: '' } }).exec().catch(() => undefined);
      throw e;
    }
  }

  // ---------- cancelling ----------

  async cancelLine(actor: Actor, lineId: string, reason: string): Promise<LabRequestView> {
    const why = text(reason);
    if (!why) throw new BadRequestException('A reason is required');
    const line = isValidObjectId(lineId) ? await this.lines.findById(lineId).exec() : null;
    if (!line) throw new NotFoundException('Lab test not found');
    const request = await this.requests.findById(line.request).exec();
    if (!request) throw new NotFoundException('Lab request not found');
    if (actor.role !== UserRole.ADMIN && request.orderedBy.id !== actor.id) {
      throw new ForbiddenException('Only the doctor who ordered this test, or an admin, can cancel it');
    }
    if (CLOSED_LINE.includes(line.status)) throw new ConflictException(`This test is already ${line.status}`);
    await this.cancelOne(actor, request, line, why);
    await this.finishIfNothingLeft(request);
    return this.get(String(request._id));
  }

  async notCollected(actor: Actor, requestId: string, reason: string): Promise<LabRequestView> {
    const why = text(reason);
    if (!why) throw new BadRequestException('A reason is required');
    const request = isValidObjectId(requestId) ? await this.requests.findById(requestId).exec() : null;
    if (!request) throw new NotFoundException('Lab request not found');
    const waiting = await this.samples.find({ request: request._id, status: 'waiting' }).exec();
    if (!waiting.length) throw new ConflictException('No sample is waiting to be collected');
    const lines = await this.lines.find({ _id: { $in: waiting.flatMap((s) => s.lines) }, status: { $nin: CLOSED_LINE } }).sort({ _id: 1 }).exec();
    for (const line of lines) {
      try {
        await this.cancelOne(actor, request, line, why);
      } catch (e) {
        if (!(e instanceof ConflictException)) throw e; // lost a race to another cancel: fine
      }
    }
    await this.finishIfNothingLeft(request);
    return this.get(String(request._id));
  }

  /** Guarded cancel of one line, its sample, and the lab.cancelled message. */
  private async cancelOne(actor: Actor, request: LabRequestDocument, line: LabLineDocument, reason: string): Promise<void> {
    const done = await this.lines
      .updateOne(
        { _id: line._id, status: { $nin: CLOSED_LINE } },
        { $set: { status: 'cancelled', cancelled: { by: actor.name, reason, at: clinicNow() } } },
      )
      .exec();
    if (!done.modifiedCount) throw new ConflictException('This test was already released or cancelled');

    for (const sample of await this.samples.find({ lines: line._id, status: { $in: ['waiting', 'collected', 'received'] } }).exec()) {
      const open = await this.lines.countDocuments({ _id: { $in: sample.lines }, status: { $ne: 'cancelled' } }).exec();
      if (!open) await this.samples.updateOne({ _id: sample._id, status: sample.status }, { status: 'cancelled' }).exec();
    }

    const stillOpen = await this.lines.find({ request: request._id, status: { $nin: CLOSED_LINE } }).select('tatDueAt').lean<{ tatDueAt: Date }[]>().exec();
    await this.messages.send({
      case: String(request.case),
      from: 'lab',
      to: ['coordinator'],
      type: 'lab.cancelled',
      priority: CASE_PRIORITY[request.priority],
      summary: `${request.number}: ${testByKey(line.test)?.label ?? line.test} cancelled`,
      payload: {
        requestId: String(request._id),
        lineId: String(line._id),
        test: line.test,
        reason,
        tatDueAt: stillOpen.length ? earliest(stillOpen.map((l) => l.tatDueAt)) : line.tatDueAt,
      },
    });
  }

  /** Nothing left to collect, or nothing left open: say so, once. */
  private async finishIfNothingLeft(request: LabRequestDocument): Promise<void> {
    const fresh = await this.requests.findById(request._id).exec();
    if (!fresh) return;
    if (!(await this.samples.exists({ request: fresh._id, status: 'waiting' }).exec())) {
      await this.announceDone(fresh._id as Types.ObjectId, 'lab.collection-done');
    }
    if (!(await this.lines.exists({ request: fresh._id, status: { $nin: CLOSED_LINE } }).exec())) {
      await this.announceDone(fresh._id as Types.ObjectId, 'lab.request-done');
    }
  }

  // ---------- location ----------

  /** Where the case's patient is: the record, else the case kind (er, ipd, opd). */
  async location(caseId: string): Promise<{ area: LabArea; ward?: string }> {
    const rec = isValidObjectId(caseId) ? await this.locations.findOne({ case: caseId }).lean().exec() : null;
    if (rec) return rec.ward ? { area: rec.area, ward: rec.ward } : { area: rec.area };
    const c = isValidObjectId(caseId) ? await this.cases.get(caseId).catch(() => null) : null;
    const kind = (c as { kind?: string } | null)?.kind;
    return { area: kind === 'er' ? 'ER' : kind === 'ipd' ? 'Ward' : 'OPD' };
  }

  async setLocation(caseId: string, area: LabArea, ward?: string): Promise<void> {
    if (!isValidObjectId(caseId)) return;
    const update = ward ? { $set: { area, ward } } : { $set: { area }, $unset: { ward: '' } };
    await this.locations.updateOne({ case: new Types.ObjectId(caseId) }, update, { upsert: true }).exec();
  }

  // ---------- reading ----------

  async get(requestId: string): Promise<LabRequestView> {
    const r = isValidObjectId(requestId) ? await this.requests.findById(requestId).exec() : null;
    if (!r) throw new NotFoundException('Lab request not found');
    return (await this.toViews([r]))[0];
  }

  async list(query: LabRequestQuery = {}): Promise<LabRequestView[]> {
    const filter: Record<string, unknown> = {};
    if (query.patientId) {
      if (!isValidObjectId(query.patientId)) throw new BadRequestException('"patientId" is not a valid id');
      filter.patient = new Types.ObjectId(query.patientId);
    }
    if (query.caseId) {
      if (!isValidObjectId(query.caseId)) throw new BadRequestException('"caseId" is not a valid id');
      filter.case = new Types.ObjectId(query.caseId);
    }
    if (query.priority) filter.priority = query.priority;
    if (query.open === true) filter.doneAt = { $exists: false };
    if (query.open === false) filter.doneAt = { $exists: true };
    const limit = Math.min(Math.max(Math.trunc(Number(query.limit)) || 100, 1), 500);
    return this.toViews(await this.requests.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit).exec());
  }

  forPatient(patientId: string): Promise<LabRequestView[]> {
    return this.list({ patientId });
  }

  private async toViews(requests: LabRequestDocument[]): Promise<LabRequestView[]> {
    if (!requests.length) return [];
    const ids = requests.map((r) => r._id);
    const [lines, samples] = await Promise.all([
      this.lines.find({ request: { $in: ids } }).sort({ _id: 1 }).exec(),
      this.samples.find({ request: { $in: ids } }).sort({ _id: 1 }).exec(),
    ]);
    const where = new Map<string, { area: LabArea; ward?: string }>();
    for (const c of new Set(requests.map((r) => String(r.case)))) where.set(c, await this.location(c));
    return requests.map((r) => ({
      id: String(r._id),
      number: r.number,
      patientId: String(r.patient),
      patientUhid: r.patientUhid,
      patientName: r.patientName,
      caseId: String(r.case),
      orderedBy: { id: r.orderedBy.id, name: r.orderedBy.name },
      priority: r.priority,
      note: r.note ?? '',
      orderedAt: iso(r.orderedAt)!,
      collectBy: iso(r.collectBy)!,
      repeatOf: r.repeatOf ? String(r.repeatOf) : null,
      scheduledFor: iso(r.scheduledFor),
      location: where.get(String(r.case))!,
      done: !!r.doneAt,
      lines: lines.filter((l) => String(l.request) === String(r._id)).map((l) => this.lineView(l)),
      samples: samples.filter((s) => String(s.request) === String(r._id)).map((s) => this.sampleView(s)),
    }));
  }

  private lineView(l: LabLineDocument): LabLineView {
    return {
      id: String(l._id),
      test: l.test,
      label: LAB_TESTS.find((t) => t.key === l.test)?.label ?? l.test,
      status: l.status,
      tatDueAt: iso(l.tatDueAt)!,
      results: l.results ?? [],
      version: l.version ?? 0,
      enteredAt: iso(l.enteredAt),
      releasedAt: iso(l.releasedAt),
      cancelled: l.cancelled ? { by: l.cancelled.by, reason: l.cancelled.reason, at: iso(l.cancelled.at)! } : null,
      critical: l.critical
        ? { active: !!l.critical.active, ackBy: l.critical.ackBy ?? null, ackAt: iso(l.critical.ackAt), ackNote: l.critical.ackNote ?? null }
        : null,
    };
  }

  private sampleView(s: LabSampleDocument): LabSampleView {
    return {
      id: String(s._id),
      number: s.number,
      tube: s.tube,
      tubeLabel: TUBE_LABEL[s.tube],
      lines: s.lines.map(String),
      status: s.status,
      collectBy: iso(s.collectBy)!,
      collected: s.collected ? { by: s.collected.by, at: iso(s.collected.at)! } : null,
      received: s.received ? { by: s.received.by, at: iso(s.received.at)! } : null,
      rejected: s.rejected ? { by: s.rejected.by, reason: s.rejected.reason, note: s.rejected.note, at: iso(s.rejected.at)! } : null,
    };
  }

  // ---------- numbers ----------

  private async nextRequestNumber(): Promise<string> {
    const c = await this.counters.findOneAndUpdate({ key: 'lab-request' }, { $inc: { last: 1 } }, { upsert: true, new: true }).exec();
    return `LR-${pad(c.last, 4)}`;
  }

  async nextSampleNumber(): Promise<string> {
    const d = clinicNow();
    const day = `${pad(d.getFullYear() % 100, 2)}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`;
    const c = await this.counters.findOneAndUpdate({ key: `lab-sample-${day}` }, { $inc: { last: 1 } }, { upsert: true, new: true }).exec();
    return `S-${day}-${pad(c.last, 4)}`;
  }
}
