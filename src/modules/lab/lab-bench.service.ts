import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import type { Priority as CasePriority } from '../coordinator/coordinator-types';
import { MessagesService } from '../coordinator/messages.service';
import { COLLECT_MINUTES, Priority, TUBE_LABEL, testByKey } from './lab-catalogue';
import { LabOrdersService } from './lab-orders.service';
import { LabLine, LabLineDocument } from './schemas/lab-line.schema';
import { LabArea } from './schemas/lab-location.schema';
import { LabRequest, LabRequestDocument } from './schemas/lab-request.schema';
import { LabSample, LabSampleDocument } from './schemas/lab-sample.schema';

const MIN_MS = 60_000;
const SUMMARY_MAX = 140;
const CLOSED_LINE = ['released', 'cancelled'];
const CASE_PRIORITY: Record<Priority, CasePriority> = { stat: 'high', urgent: 'medium', routine: 'low' };
const PRIORITY_RANK: Record<Priority, number> = { stat: 0, urgent: 1, routine: 2 };

export const REJECT_REASONS = ['haemolysed', 'clotted', 'wrong-tube', 'unlabelled', 'insufficient', 'other'] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export interface CollectionItem {
  sampleId: string;
  sampleNumber: string;
  tube: string;
  tubeLabel: string;
  tests: string[];
  requestId: string;
  requestNumber: string;
  priority: Priority;
  /** For staff screens only: never in a message. */
  patientName: string;
  patientUhid: string;
  location: { area: LabArea; ward?: string };
  collectBy: string;
  overdue: boolean;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const cut = (s: string) => s.slice(0, SUMMARY_MAX);

/** The bench: collecting, receiving and rejecting samples. */
@Injectable()
export class LabBenchService {
  constructor(
    @InjectModel(LabRequest.name) private readonly requests: Model<LabRequestDocument>,
    @InjectModel(LabLine.name) private readonly lines: Model<LabLineDocument>,
    @InjectModel(LabSample.name) private readonly samples: Model<LabSampleDocument>,
    private readonly orders: LabOrdersService,
    private readonly messages: MessagesService,
  ) {}

  // ---------- collecting ----------

  async collect(actor: Actor, sampleNumber: string): Promise<void> {
    const sample = await this.samples.findOne({ number: text(sampleNumber) }).exec();
    if (!sample) throw new NotFoundException('Sample not found');
    const notWaiting = () => new ConflictException("This sample isn't waiting to be collected.");
    if (sample.status !== 'waiting') throw notWaiting();
    const claimed = await this.samples
      .findOneAndUpdate({ _id: sample._id, status: 'waiting' }, { $set: { status: 'collected', collected: { by: actor.name, at: clinicNow() }, collectedRealAt: new Date() } }, { new: true })
      .exec();
    if (!claimed) throw notWaiting();
    await this.lines.updateMany({ _id: { $in: claimed.lines }, status: 'ordered' }, { $set: { status: 'collected' } }).exec();

    const request = await this.requests.findById(claimed.request).exec();
    if (!request) throw new NotFoundException('Lab request not found');
    const sampleLines = await this.lines.find({ _id: { $in: claimed.lines } }).sort({ _id: 1 }).exec();
    const tests = sampleLines.map((l) => l.test);
    await this.messages.send({
      case: String(request.case),
      from: 'lab',
      to: ['coordinator'],
      type: 'lab.collected',
      priority: CASE_PRIORITY[request.priority],
      summary: cut(`${request.number}: ${claimed.number} collected (${TUBE_LABEL[claimed.tube]}: ${tests.map((t) => testByKey(t)?.label ?? t).join(', ')})`),
      payload: { requestId: String(request._id), sampleId: String(claimed._id), sampleNumber: claimed.number, tube: claimed.tube, tests },
      dedupeKey: `lab.collected:${claimed._id}`,
    });

    const fresh = await this.requests.findById(request._id).exec();
    if (fresh && !(await this.samples.exists({ request: fresh._id, status: 'waiting' }).exec())) {
      await this.orders.announceDone(fresh._id as Types.ObjectId, 'lab.collection-done');
    }
  }

  // ---------- receiving ----------

  async receive(actor: Actor, sampleId: string): Promise<void> {
    const sample = await this.sampleById(sampleId);
    const notCollected = () => new ConflictException("This sample hasn't been collected, or was already received.");
    if (sample.status !== 'collected') throw notCollected();
    const claimed = await this.samples
      .findOneAndUpdate({ _id: sample._id, status: 'collected' }, { $set: { status: 'received', received: { by: actor.name, at: clinicNow() } } }, { new: true })
      .exec();
    if (!claimed) throw notCollected();
    await this.lines.updateMany({ _id: { $in: claimed.lines }, status: 'collected' }, { $set: { status: 'received' } }).exec();

    const request = await this.requests.findById(claimed.request).exec();
    if (!request) throw new NotFoundException('Lab request not found');
    const first = await this.requests.findOneAndUpdate({ _id: request._id, firstReceivedAt: { $exists: false } }, { $set: { firstReceivedAt: new Date() } }).exec();
    const open = await this.lines.find({ request: request._id, status: { $nin: CLOSED_LINE } }).select('tatDueAt').lean<{ tatDueAt: Date }[]>().exec();
    const tatDueAt = open.length ? new Date(Math.min(...open.map((l) => l.tatDueAt.getTime()))) : new Date();
    await this.messages.send({
      case: String(request.case),
      from: 'lab',
      to: ['coordinator'],
      type: 'lab.received',
      priority: CASE_PRIORITY[request.priority],
      summary: cut(`${request.number}: ${claimed.number} received (${TUBE_LABEL[claimed.tube]})`),
      payload: { requestId: String(request._id), sampleId: String(claimed._id), firstReceive: !!first, tatDueAt },
      dedupeKey: `lab.received:${claimed._id}`,
    });
  }

  // ---------- rejecting ----------

  async reject(actor: Actor, sampleId: string, reason: string, note?: string): Promise<void> {
    if (!(REJECT_REASONS as readonly string[]).includes(reason)) throw new BadRequestException(`Reason must be one of: ${REJECT_REASONS.join(', ')}`);
    const why = text(note);
    if (reason === 'other' && !why) throw new BadRequestException('Say what was wrong with the sample');
    const sample = await this.sampleById(sampleId);
    const cannot = () => new ConflictException('Only a collected or received sample can be rejected.');
    if (sample.status !== 'collected' && sample.status !== 'received') throw cannot();
    const redoable = await this.lines.exists({ _id: { $in: sample.lines }, status: { $in: ['collected', 'received'] } }).exec();
    if (!redoable) throw new ConflictException('Nothing left to recollect on this sample.');
    const claimed = await this.samples
      .findOneAndUpdate(
        { _id: sample._id, status: { $in: ['collected', 'received'] } },
        { $set: { status: 'rejected', rejected: { by: actor.name, reason, note: why, at: clinicNow() } } },
        { new: true },
      )
      .exec();
    if (!claimed) throw cannot();

    const request = await this.requests.findById(claimed.request).exec();
    if (!request) throw new NotFoundException('Lab request not found');
    const redo = await this.lines.find({ _id: { $in: claimed.lines }, status: { $in: ['collected', 'received'] } }).sort({ _id: 1 }).exec();
    const recollectBy = new Date(Date.now() + COLLECT_MINUTES[request.priority] * MIN_MS);
    const replacement = await this.samples.create({
      number: await this.orders.nextSampleNumber(),
      request: request._id,
      tube: claimed.tube,
      lines: redo.map((l) => l._id),
      status: 'waiting',
      collectBy: recollectBy,
      replaces: claimed._id,
    });
    await this.lines.updateMany({ _id: { $in: redo.map((l) => l._id) } }, { $set: { status: 'ordered' } }).exec();
    // Collection is open again: the next full collection says "done" again and stops the recollect clock.
    await this.requests.updateOne({ _id: request._id }, { $unset: { collectionDoneAt: '' } }).exec();
    await this.messages.send({
      case: String(request.case),
      from: 'lab',
      to: ['coordinator'],
      type: 'lab.rejected',
      priority: CASE_PRIORITY[request.priority],
      summary: cut(`${request.number}: ${claimed.number} rejected (${reason}), recollect as ${replacement.number}`),
      payload: { requestId: String(request._id), sampleId: String(claimed._id), newSampleId: String(replacement._id), reason, recollectBy },
      dedupeKey: `lab.rejected:${claimed._id}`,
    });
  }

  // ---------- the collection list ----------

  async collectionList(area?: LabArea): Promise<CollectionItem[]> {
    const waiting = await this.samples.find({ status: 'waiting' }).sort({ _id: 1 }).exec();
    if (!waiting.length) return [];
    const requests = await this.requests.find({ _id: { $in: [...new Set(waiting.map((s) => String(s.request)))] }, doneAt: { $exists: false } }).exec();
    const byId = new Map(requests.map((r) => [String(r._id), r]));
    const lines = await this.lines.find({ _id: { $in: waiting.flatMap((s) => s.lines) } }).exec();
    const lineById = new Map(lines.map((l) => [String(l._id), l]));
    const where = new Map<string, { area: LabArea; ward?: string }>();
    const now = Date.now();
    const out: CollectionItem[] = [];
    for (const s of waiting) {
      const r = byId.get(String(s.request));
      if (!r) continue;
      const key = String(r.case);
      if (!where.has(key)) where.set(key, await this.orders.location(key));
      const location = where.get(key)!;
      if (area && location.area !== area) continue;
      const tests = s.lines.map((id) => lineById.get(String(id))?.test).filter((t): t is string => !!t);
      out.push({
        sampleId: String(s._id),
        sampleNumber: s.number,
        tube: s.tube,
        tubeLabel: TUBE_LABEL[s.tube],
        tests: tests.map((t) => testByKey(t)?.label ?? t),
        requestId: String(r._id),
        requestNumber: r.number,
        priority: r.priority,
        patientName: r.patientName,
        patientUhid: r.patientUhid,
        location,
        collectBy: s.collectBy.toISOString(),
        overdue: s.collectBy.getTime() < now,
      });
    }
    return out.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.collectBy.localeCompare(b.collectBy));
  }

  // ---------- helpers ----------

  private async sampleById(id: string): Promise<LabSampleDocument> {
    const s = isValidObjectId(id) ? await this.samples.findById(id).exec() : null;
    if (!s) throw new NotFoundException('Sample not found');
    return s;
  }
}
