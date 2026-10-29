import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow, displayDateTime } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import type { Priority as CasePriority } from '../coordinator/coordinator-types';
import { MessagesService } from '../coordinator/messages.service';
import { Clock, ClockDocument } from '../coordinator/schemas/clock.schema';
import { LabReportDocument, LabTestReport } from '../lab-reports/schemas/lab-report.schema';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { LabAiService } from './lab-ai';
import { LabTestDef, effectiveLimits, flagValue, testByKey } from './lab-catalogue';
import { LabOrdersService, RECONCILE_BATCH, RECONCILE_GRACE_MS } from './lab-orders.service';
import { writeLabReport } from './lab-report-writer';
import { LabSettingsService } from './lab-settings.service';
import { LabLine, LabLineDocument, LabResultRow } from './schemas/lab-line.schema';
import { LabRequest, LabRequestDocument } from './schemas/lab-request.schema';

const SUMMARY_MAX = 140;
const ACK_MINUTES = 15;
const CLOSED_LINE = ['released', 'cancelled'];
const CASE_PRIORITY: Record<string, CasePriority> = { stat: 'high', urgent: 'medium', routine: 'low' };

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const cut = (s: string) => s.slice(0, SUMMARY_MAX);

/**
 * The critical values a line still waits on: those of its latest released version, or (after an
 * amendment to normal that kept an unacknowledged critical open) of the last version that had any.
 * `latest` says which. Null when no released version had a critical value.
 */
export function lastCritical(line: Pick<LabLine, 'history'>): { rows: LabResultRow[]; version: number; latest: boolean } | null {
  const history = line.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const rows = (history[i].results ?? []).filter((r) => r.critical);
    if (rows.length) return { rows, version: history[i].version, latest: i === history.length - 1 };
  }
  return null;
}

/** Entering, validating and releasing results; critical values; amendments. */
@Injectable()
export class LabResultsService {
  constructor(
    @InjectModel(LabRequest.name) private readonly requests: Model<LabRequestDocument>,
    @InjectModel(LabLine.name) private readonly lines: Model<LabLineDocument>,
    @InjectModel(LabTestReport.name) private readonly reports: Model<LabReportDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
    private readonly orders: LabOrdersService,
    private readonly messages: MessagesService,
    private readonly labSettings: LabSettingsService,
    private readonly labAi: LabAiService,
    @InjectModel(Clock.name) private readonly clocks: Model<ClockDocument>,
  ) {}

  private readonly logger = new Logger(LabResultsService.name);

  // ---------- entering ----------

  async enterResults(actor: Actor, lineId: string, values: Record<string, number | string>): Promise<void> {
    const line = await this.lineById(lineId);
    const wait = () => new ConflictException("This test isn't waiting for results.");
    if (line.status !== 'received') throw wait();
    const rows = this.flag(line.test, values, (await this.labSettings.overrides()).criticalLimits);
    const done = await this.lines
      .findOneAndUpdate(
        { _id: line._id, status: 'received' },
        {
          $set: { status: 'awaiting-validation', results: rows, enteredBy: { id: actor.id, name: actor.name }, enteredAt: clinicNow() },
          $unset: { sentBack: '' },
        },
      )
      .exec();
    if (!done) throw wait();
  }

  // ---------- sending back ----------

  async sendBack(actor: Actor, lineId: string, reason: string): Promise<void> {
    const why = text(reason);
    if (!why) throw new BadRequestException('A reason is required');
    const line = await this.lineById(lineId);
    const cannot = () => new ConflictException("This test isn't waiting for validation.");
    if (line.status !== 'awaiting-validation') throw cannot();
    const sentBack = { by: actor.name, reason: why, at: clinicNow() };
    const last = line.pendingAmendReason ? line.history[line.history.length - 1] : undefined;
    // A rejected amendment goes back to the released result; a first entry goes back to the bench.
    const update = last
      ? { $set: { status: 'released', results: last.results, enteredBy: last.enteredBy, enteredAt: last.enteredAt }, $unset: { pendingAmendReason: '', sentBack: '' } }
      : { $set: { status: 'received', results: [], sentBack }, $unset: { enteredBy: '', enteredAt: '' } };
    const done = await this.lines.findOneAndUpdate({ _id: line._id, status: 'awaiting-validation' }, update).exec();
    if (!done) throw cannot();
  }

  // ---------- releasing ----------

  async release(actor: Actor, lineId: string): Promise<void> {
    const line = await this.lineById(lineId);
    const cannot = () => new ConflictException("This test isn't waiting for validation.");
    if (line.status !== 'awaiting-validation') throw cannot();
    if (line.enteredBy?.id === actor.id) throw new ForbiddenException('Someone else must validate this result.');
    const request = await this.requests.findById(line.request).exec();
    if (!request) throw new NotFoundException('Lab request not found');
    const def = testByKey(line.test)!;

    const version = (line.version ?? 0) + 1;
    const releasedAt = clinicNow();
    const validatedBy = { id: actor.id, name: actor.name };
    const criticals = line.results.filter((r) => r.critical);
    const entry: LabLine['history'][number] = { version, results: line.results, enteredBy: line.enteredBy, enteredAt: line.enteredAt, validatedBy, releasedAt };
    // An amendment to normal cannot drop a critical nobody has acknowledged yet.
    const keepOpen = !criticals.length && !!line.critical?.active && !line.critical.ackAt;
    const critical = keepOpen ? { active: true } : { active: criticals.length > 0 };
    if (line.pendingAmendReason) entry.amendReason = line.pendingAmendReason;
    const released = await this.lines
      .findOneAndUpdate(
        { _id: line._id, status: 'awaiting-validation', version: line.version ?? 0, 'enteredBy.id': line.enteredBy?.id },
        {
          $set: { status: 'released', version, validatedBy, releasedAt, lastReleasedRealAt: new Date(), ...(version === 1 ? { releasedRealAt: new Date() } : {}), critical },
          $push: { history: entry },
          $unset: { pendingAmendReason: '', sentBack: '' },
        },
        { new: true },
      )
      .exec();
    if (!released) throw cannot();

    // The critical work comes first, so a failure further on never leaves a critical result unannounced.
    if (keepOpen) {
      const was = (line.history[line.history.length - 1]?.results ?? []).filter((r) => r.critical);
      await this.amendAlert(request, line._id as Types.ObjectId, def, was, line.results);
    }
    if (criticals.length) {
      await this.sendCriticals(request, line, def, criticals, version);
      await this.raiseAlert(request, line, def, criticals[0]);
    }

    const reportId = await this.writeReport(released, request, def, version);
    // The AI never delays or blocks a release: the template is already on the report, and a valid AI summary replaces it later.
    void this.labAi
      .summarise(String(released._id))
      .then(async (summary) => {
        const { sample, ...rest } = summary;
        const aiSummary = { ...rest, sample };
        const still = await this.lines.exists({ _id: released._id, version }).exec();
        if (still) await this.reports.updateOne({ _id: reportId }, { $set: { aiSummary } }).exec();
      })
      .catch((e) => this.logger.warn(`Lab AI summary failed (${e instanceof Error ? e.name : typeof e}); the template stays`));

    const open = await this.lines.find({ request: request._id, status: { $nin: CLOSED_LINE } }).select('tatDueAt').lean<{ tatDueAt: Date }[]>().exec();
    const tatDueAt = open.length ? new Date(Math.min(...open.map((l) => l.tatDueAt.getTime()))) : line.tatDueAt;
    const flag = criticals.length ? 'critical' : line.results.some((r) => r.flag !== 'normal') ? 'abnormal' : 'normal';
    await this.messages.send({
      case: String(request.case),
      from: 'lab',
      to: ['coordinator'],
      type: 'lab.resulted',
      priority: CASE_PRIORITY[request.priority],
      summary: cut(`${request.number}: ${def.label} released${flag === 'normal' ? '' : ` (${flag})`}`),
      payload: { requestId: String(request._id), lineId: String(line._id), test: line.test, flag, version, tatDueAt },
      dedupeKey: `lab.resulted:${line._id}:${version}`,
    });

    if (!open.length) await this.orders.announceDone(request._id as Types.ObjectId, 'lab.request-done');
  }

  /** One lab.critical per critical value of a released version; the key per line, version and parameter. */
  private async sendCriticals(request: LabRequestDocument, line: LabLineDocument, def: LabTestDef, criticals: LabResultRow[], version: number): Promise<void> {
    for (const c of criticals) {
      await this.messages.send({
        case: String(request.case),
        from: 'lab',
        to: ['coordinator'],
        type: 'lab.critical',
        priority: 'high',
        summary: cut(`${request.number}: ${def.label} critical (${c.param})`),
        payload: { requestId: String(request._id), requestNumber: request.number, lineId: String(line._id), test: line.test, parameter: c.param, value: String(c.value), unit: c.unit, version },
        dedupeKey: `lab.critical:${line._id}:${version}:${c.param}`,
      });
    }
  }

  private async sendAcked(request: LabRequestDocument, line: LabLineDocument): Promise<void> {
    await this.messages.send({
      case: String(request.case),
      from: 'lab',
      to: ['coordinator'],
      type: 'lab.critical-acked',
      priority: 'high',
      summary: cut(`${request.number}: ${testByKey(line.test)?.label ?? line.test} critical acknowledged`),
      payload: { lineId: String(line._id) },
      dedupeKey: `lab.critical-acked:${line._id}:${line.version}`,
    });
  }

  // ---------- reconcile ----------

  /**
   * The critical-result branches of the reconcile pass the scheduler runs every minute (after
   * LabOrdersService.reconcile's (a) to (d)), for a crash between the work and the message:
   * (e) an unacknowledged critical with no acknowledgement clock for its latest release (none running,
   * none escalating, none started since that release) gets lab.critical again with the same keys, and its
   * alert; (f) an acknowledged critical whose clock still runs or escalates gets lab.critical-acked again.
   * Lines touched in the last 30 seconds are left to the request in flight. Each line has its own try/catch.
   */
  async reconcileCriticals(): Promise<{ critical: number; acked: number }> {
    const out = { critical: 0, acked: 0 };
    const settled = new Date(Date.now() - RECONCILE_GRACE_MS);
    const item = async (what: string, fn: () => Promise<boolean>): Promise<boolean> => {
      try {
        return await fn();
      } catch (e) {
        this.logger.error(`Reconcile: ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    };

    // (e)
    const waiting = await this.lines
      .find({ 'critical.active': true, 'critical.ackAt': { $exists: false }, updatedAt: { $lt: settled } })
      .sort({ _id: 1 })
      .limit(RECONCILE_BATCH)
      .exec();
    for (const line of waiting) {
      if (await item(`resending the critical of lab line ${line._id}`, () => this.resendCritical(line))) out.critical++;
    }

    // (f)
    const open = await this.clocks
      .find({ def: 'lab-critical', $or: [{ state: 'running' }, { state: 'expired', stoppedAt: { $exists: false } }] })
      .select('ref')
      .lean<{ ref?: string | null }[]>()
      .exec();
    const refs = [...new Set(open.map((c) => c.ref).filter((r): r is string => !!r && isValidObjectId(r)))];
    const acked = refs.length
      ? await this.lines
          .find({ _id: { $in: refs }, 'critical.ackAt': { $exists: true }, updatedAt: { $lt: settled } })
          .sort({ _id: 1 })
          .limit(RECONCILE_BATCH)
          .exec()
      : [];
    for (const line of acked) {
      const sent = await item(`resending the acknowledgement of lab line ${line._id}`, async () => {
        const request = await this.requests.findById(line.request).exec();
        if (!request) return false;
        await this.sendAcked(request, line);
        return true;
      });
      if (sent) out.acked++;
    }
    return out;
  }

  /** (e) for one line. True when it resent. */
  private async resendCritical(line: LabLineDocument): Promise<boolean> {
    const since = line.lastReleasedRealAt ? new Date(line.lastReleasedRealAt).getTime() : 0;
    const clocks = await this.clocks
      .find({ def: 'lab-critical', ref: String(line._id) })
      .select('state startedAt stoppedAt')
      .lean<{ state: string; startedAt: Date; stoppedAt?: Date }[]>()
      .exec();
    const covered = clocks.some((c) => c.state === 'running' || (c.state === 'expired' && !c.stoppedAt) || new Date(c.startedAt).getTime() >= since);
    if (covered) return false;
    const request = await this.requests.findById(line.request).exec();
    const def = testByKey(line.test);
    const source = lastCritical(line);
    if (!request || !def || !source) return false;
    await this.sendCriticals(request, line, def, source.rows, source.version);
    // An acknowledgement that landed meanwhile must not reopen the alert.
    if (!(await this.lines.exists({ _id: line._id, 'critical.ackAt': { $exists: false } }).exec())) return true;
    if (source.latest) await this.raiseAlert(request, line, def, source.rows[0]);
    else await this.amendAlert(request, line._id as Types.ObjectId, def, source.rows, line.history[line.history.length - 1]?.results ?? [], true);
    return true;
  }

  // ---------- acknowledging ----------

  async acknowledge(actor: Actor, lineId: string, note?: string): Promise<void> {
    const line = await this.lineById(lineId);
    const none = () => new ConflictException('Nothing to acknowledge.');
    if (!line.critical?.active || line.critical.ackAt) throw none();
    const done = await this.lines
      .findOneAndUpdate(
        { _id: line._id, 'critical.active': true, 'critical.ackAt': { $exists: false } },
        { $set: { 'critical.ackBy': actor.name, 'critical.ackById': actor.id, 'critical.ackAt': clinicNow(), 'critical.ackNote': text(note) } },
        { new: true },
      )
      .exec();
    if (!done) throw none();
    await this.alerts.updateOne({ link: `lab-line:${line._id}` }, { $set: { status: 'Completed' } }).exec();
    const request = await this.requests.findById(line.request).exec();
    if (!request) throw new NotFoundException('Lab request not found');
    await this.sendAcked(request, line);
  }

  // ---------- amending ----------

  async amend(actor: Actor, lineId: string, values: Record<string, number | string>, reason: string): Promise<void> {
    const why = text(reason);
    if (!why) throw new BadRequestException('A reason is required');
    const line = await this.lineById(lineId);
    const cannot = () => new ConflictException('Only a released result can be amended.');
    if (line.status !== 'released') throw cannot();
    const rows = this.flag(line.test, values, (await this.labSettings.overrides()).criticalLimits);
    const done = await this.lines
      .findOneAndUpdate(
        { _id: line._id, status: 'released', version: line.version },
        { $set: { status: 'awaiting-validation', results: rows, enteredBy: { id: actor.id, name: actor.name }, enteredAt: clinicNow(), pendingAmendReason: why } },
      )
      .exec();
    if (!done) throw cannot();
  }

  // ---------- helpers ----------

  private async lineById(id: string): Promise<LabLineDocument> {
    const l = isValidObjectId(id) ? await this.lines.findById(id).exec() : null;
    if (!l) throw new NotFoundException('Lab test not found');
    return l;
  }

  /** Every catalogue parameter, nothing else; flagged with the fixed rules. */
  private flag(test: string, values: Record<string, number | string>, criticalLimits?: Parameters<typeof effectiveLimits>[0]): LabResultRow[] {
    const def = testByKey(test);
    if (!def) throw new BadRequestException(`Unknown test "${test}"`);
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new BadRequestException('Results are required');
    const names = def.params.map((p) => p.name);
    const unknown = Object.keys(values).filter((k) => !names.includes(k));
    if (unknown.length) throw new BadRequestException(`Unknown parameter: ${unknown.join(', ')}`);
    const missing = names.filter((n) => values[n] === undefined || values[n] === null || values[n] === '');
    if (missing.length) throw new BadRequestException(`Missing result: ${missing.join(', ')}`);
    const limits = effectiveLimits(criticalLimits);
    return def.params.map((p) => {
      const raw = values[p.name];
      const value = p.text && typeof raw === 'string' ? raw.trim() : raw;
      try {
        return { param: p.name, value, unit: p.unit, ...flagValue(test, p.name, value, limits) };
      } catch (e) {
        throw new BadRequestException(e instanceof Error ? e.message : 'Invalid result');
      }
    });
  }

  private writeReport(line: LabLineDocument, request: LabRequestDocument, def: LabTestDef, version: number): Promise<Types.ObjectId> {
    return writeLabReport(this.reports, this.lines, line, request, def, version);
  }

  /** The earlier critical was amended to normal but is still unacknowledged: say so on its alert (made, with `upsert`, when the reconcile pass finds it missing). */
  private async amendAlert(request: LabRequestDocument, lineId: Types.ObjectId, def: LabTestDef, was: LabResultRow[], now: LabResultRow[], upsert = false): Promise<void> {
    const old = was.map((r) => `${r.param} ${r.value} ${r.unit}`.trim()).join(', ');
    const nowText = now.map((r) => `${r.param} ${r.value}`).join(', ');
    const link = `lab-line:${lineId}`;
    await this.alerts
      .updateOne(
        { link },
        {
          $set: { title: `Critical (amended): ${def.label} — acknowledge the correction`, subtitle: `Was ${old}; now ${nowText} · For ${request.orderedBy.name}`, status: 'Pending' },
          ...(upsert
            ? { $setOnInsert: { link, patientName: request.patientName, uhid: request.patientUhid, type: 'Lab Alert', category: 'Critical', priority: 'High', dueDateTime: displayDateTime(new Date(clinicNow().getTime() + ACK_MINUTES * 60_000)) } }
            : {}),
        },
        { upsert },
      )
      .exec();
  }

  /** One alert per line: an amendment to a new critical value reopens it. */
  private async raiseAlert(request: LabRequestDocument, line: LabLineDocument, def: LabTestDef, c: LabResultRow): Promise<void> {
    const link = `lab-line:${line._id}`;
    await this.alerts
      .findOneAndUpdate(
        { link },
        {
          $set: {
            title: `Critical: ${def.label} ${c.param} ${c.value} ${c.unit}`.trim(),
            subtitle: `For ${request.orderedBy.name} · acknowledge within ${ACK_MINUTES} min`,
            patientName: request.patientName,
            uhid: request.patientUhid,
            type: 'Lab Alert',
            category: 'Critical',
            priority: 'High',
            status: 'Pending',
            dueDateTime: displayDateTime(new Date(clinicNow().getTime() + ACK_MINUTES * 60_000)),
          },
          $setOnInsert: { link },
        },
        { upsert: true },
      )
      .exec();
  }
}
