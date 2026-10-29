import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow, displayDate, displayDateTime, displayTime } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import type { Priority as CasePriority } from '../coordinator/coordinator-types';
import { MessagesService } from '../coordinator/messages.service';
import { LabReportDocument, LabTestReport } from '../lab-reports/schemas/lab-report.schema';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { LabAiService, templateSummary } from './lab-ai';
import { LabTestDef, effectiveLimits, flagValue, rangeText, testByKey } from './lab-catalogue';
import { LabOrdersService } from './lab-orders.service';
import { LabSettingsService } from './lab-settings.service';
import { LabLine, LabLineDocument, LabResultRow } from './schemas/lab-line.schema';
import { LabRequest, LabRequestDocument } from './schemas/lab-request.schema';

const SUMMARY_MAX = 140;
const ACK_MINUTES = 15;
const CLOSED_LINE = ['released', 'cancelled'];
const CASE_PRIORITY: Record<string, CasePriority> = { stat: 'high', urgent: 'medium', routine: 'low' };
const STATUS_LABEL = { normal: 'Normal', low: 'Low', high: 'High', abnormal: 'Abnormal' } as const;

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const cut = (s: string) => s.slice(0, SUMMARY_MAX);

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

    if (keepOpen) {
      const was = (line.history[line.history.length - 1]?.results ?? []).filter((r) => r.critical);
      await this.amendAlert(request, line._id as Types.ObjectId, def, was, line.results);
    }
    if (criticals.length) {
      for (const c of criticals) {
        await this.messages.send({
          case: String(request.case),
          from: 'lab',
          to: ['coordinator'],
          type: 'lab.critical',
          priority: 'high',
          summary: cut(`${request.number}: ${def.label} critical (${c.param})`),
          payload: { requestId: String(request._id), lineId: String(line._id), test: line.test, parameter: c.param, value: String(c.value), unit: c.unit, version },
          dedupeKey: `lab.critical:${line._id}:${version}:${c.param}`,
        });
      }
      await this.raiseAlert(request, line, def, criticals[0]);
    }

    if (!open.length) await this.orders.announceDone(request._id as Types.ObjectId, 'lab.request-done');
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

  /** One LabTestReport per line: a later release or amendment updates it. */
  private async writeReport(line: LabLineDocument, request: LabRequestDocument, def: LabTestDef, version: number): Promise<Types.ObjectId> {
    const now = clinicNow();
    const parameters = line.results.map((r) => ({
      name: r.param,
      result: r.value,
      referenceRange: rangeText(def.key, def.params.find((p) => p.name === r.param)!),
      unit: r.unit,
      status: STATUS_LABEL[r.flag],
      critical: r.critical,
    }));
    const fields = {
      uhid: request.patientUhid,
      testName: def.label,
      category: def.category,
      date: displayDate(now),
      time: displayTime(now),
      status: line.results.some((r) => r.flag !== 'normal') ? 'Abnormal' : 'Completed',
      groups: [{ category: def.label, parameters }],
      labLine: String(line._id),
      amended: version > 1,
      aiSummary: {
        sample: false,
        ...templateSummary(
        line.results.map((r, i) => ({ name: r.param, value: r.value, unit: r.unit, referenceRange: parameters[i].referenceRange, flag: r.flag, critical: r.critical })),
        ),
      },
    };
    let report = line.reportId ? await this.reports.findByIdAndUpdate(line.reportId, { $set: fields }, { new: true }).exec() : null;
    if (!report) {
      report = await this.reports.create(fields);
      await this.lines.updateOne({ _id: line._id }, { $set: { reportId: report._id } }).exec();
    }
    return report._id as Types.ObjectId;
  }

  /** The earlier critical was amended to normal but is still unacknowledged: say so on its alert. */
  private async amendAlert(request: LabRequestDocument, lineId: Types.ObjectId, def: LabTestDef, was: LabResultRow[], now: LabResultRow[]): Promise<void> {
    const old = was.map((r) => `${r.param} ${r.value} ${r.unit}`.trim()).join(', ');
    const nowText = now.map((r) => `${r.param} ${r.value}`).join(', ');
    await this.alerts
      .updateOne(
        { link: `lab-line:${lineId}` },
        { $set: { title: `Critical (amended): ${def.label} — acknowledge the correction`, subtitle: `Was ${old}; now ${nowText} · For ${request.orderedBy.name}`, status: 'Pending' } },
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
