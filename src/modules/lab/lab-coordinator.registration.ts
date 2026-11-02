import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentRegistry } from '../coordinator/agent-registry';
import { AgentDefinition, ClockDef, MessageTypeDef } from '../coordinator/coordinator-types';
import { MessagesService } from '../coordinator/messages.service';
import { testByKey } from './lab-catalogue';
import { LabOrdersService } from './lab-orders.service';
import { LabLine, LabLineDocument } from './schemas/lab-line.schema';
import { LabRequest, LabRequestDocument } from './schemas/lab-request.schema';

const type = (t: string, description: string, payload: MessageTypeDef['payload']): MessageTypeDef => ({
  type: t,
  agent: 'lab',
  description,
  payload,
});

export const LAB_MESSAGE_TYPES: MessageTypeDef[] = [
  type('lab.ordered', 'Lab tests were ordered', { requestId: 'string', requestNumber: 'string', priority: 'string', tests: 'string[]', collectBy: 'date', tatDueAt: 'date' }),
  // The free-text reason stays on the line, never in a message.
  type('lab.cancelled', 'A lab test was cancelled', { requestId: 'string', lineId: 'string', test: 'string', tatDueAt: 'date', escalateAt: 'date' }),
  type('lab.collected', 'A sample was collected', { requestId: 'string', sampleId: 'string', sampleNumber: 'string', tube: 'string', tests: 'string[]' }),
  type('lab.collection-done', 'Every sample for a request was collected', { requestId: 'string' }),
  // `tests` here: the request's open tests, which its turnaround clock covers.
  type('lab.received', 'A sample reached the lab', { requestId: 'string', requestNumber: 'string', sampleId: 'string', firstReceive: 'boolean', tests: 'string[]', tatDueAt: 'date', escalateAt: 'date' }),
  // `tests` here: the tests to recollect.
  type('lab.rejected', 'A sample was rejected and needs recollecting', { requestId: 'string', requestNumber: 'string', sampleId: 'string', newSampleId: 'string', reason: 'string', tests: 'string[]', recollectBy: 'date' }),
  // tatDueAt: the earliest open line's due (the on-time figure); escalateAt: when the turnaround clock escalates.
  type('lab.resulted', 'A lab result was released', { requestId: 'string', lineId: 'string', test: 'string', flag: 'string', version: 'number', tatDueAt: 'date', escalateAt: 'date' }),
  type('lab.request-done', 'Every test on a request is finished', { requestId: 'string' }),
  type('lab.critical', 'A critical lab value was found', { requestId: 'string', requestNumber: 'string', lineId: 'string', test: 'string', parameter: 'string', value: 'string', unit: 'string', version: 'number' }),
  type('lab.critical-acked', 'A doctor acknowledged a critical value', { lineId: 'string' }),
];

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const date = (key: string) => (payload: Record<string, unknown>): Date | null => {
  const v = payload[key];
  const d = typeof v === 'string' || v instanceof Date ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d : null;
};
const byRequest = (_t: string, p: Record<string, unknown>) => str(p.requestId);
const labelOf = (test: string) => testByKey(test)?.label ?? test;
const DETAIL_TESTS = 3;

/** "LR-0019 · Complete blood count, Troponin I" (three tests, then "+N more"): what an escalation is about, never a name. */
const requestDetail = (p: Record<string, unknown>): string | null => {
  const number = str(p.requestNumber);
  if (!number) return null;
  const tests = Array.isArray(p.tests) ? p.tests.filter((t): t is string => typeof t === 'string').map(labelOf) : [];
  const shown = tests.slice(0, DETAIL_TESTS).join(', ') + (tests.length > DETAIL_TESTS ? ` +${tests.length - DETAIL_TESTS} more` : '');
  return shown ? `${number} · ${shown}` : number;
};

/** "LR-0019 · Complete blood count · Haemoglobin"; the parameter is left out when it repeats the label ("LR-0019 · Troponin I"). */
const criticalDetail = (p: Record<string, unknown>): string | null => {
  const number = str(p.requestNumber);
  const test = str(p.test);
  if (!number || !test) return null;
  const label = labelOf(test);
  const param = str(p.parameter);
  return [number, label, ...(param && param !== label ? [param] : [])].join(' · ');
};

/** Exported for the demo seed, so seeded clocks carry the same detail the live ones do. */
export const LAB_CLOCKS: ClockDef[] = [
  {
    key: 'lab-collect',
    agent: 'lab',
    label: 'Sample collection',
    startOn: 'lab.ordered',
    stopOn: ['lab.collection-done', 'lab.request-done'],
    minutes: 240,
    ladder: 'lab',
    dueFrom: date('collectBy'),
    refFrom: byRequest,
    detailFrom: requestDetail,
  },
  {
    key: 'lab-recollect',
    agent: 'lab',
    label: 'Sample recollection',
    startOn: 'lab.rejected',
    stopOn: ['lab.collection-done', 'lab.request-done'],
    minutes: 240,
    ladder: 'lab',
    dueFrom: date('recollectBy'),
    refFrom: byRequest,
    detailFrom: requestDetail,
  },
  {
    key: 'lab-tat',
    agent: 'lab',
    label: 'Lab turnaround',
    startOn: 'lab.received',
    stopOn: ['lab.request-done'],
    minutes: 240,
    ladder: 'lab',
    // match gates start, stop and update alike: only the first receive starts the clock.
    match: (t, p) => t !== 'lab.received' || p.firstReceive === true,
    // Ruling F1: escalate at the later of the due and the first receipt plus the target.
    dueFrom: date('escalateAt'),
    refFrom: byRequest,
    updateOn: ['lab.resulted', 'lab.cancelled'],
    detailFrom: requestDetail,
  },
  {
    key: 'lab-critical',
    agent: 'lab',
    label: 'Critical result acknowledgement',
    startOn: 'lab.critical',
    stopOn: ['lab.critical-acked'],
    minutes: 15,
    ladder: 'lab-critical',
    refFrom: (_t, p) => str(p.lineId),
    // One acknowledgement path: the result itself. Its escalation rides on the line's alert and closes with the acknowledgement.
    resolveEscalationOnStop: true,
    alertLink: (ref) => (ref ? `lab-line:${ref}` : null),
    detailFrom: criticalDetail,
  },
];

/**
 * The share of lines released since `since` (real time) that met their due. Null when none were released.
 * Both the agent status and the overview use it; it compares real stamps only.
 */
export async function labOnTimePct(lines: Model<LabLineDocument>, since: Date): Promise<number | null> {
  const done = await lines.find({ releasedRealAt: { $gte: since } }).select('tatDueAt releasedRealAt').lean<{ tatDueAt: Date; releasedRealAt: Date }[]>().exec();
  if (!done.length) return null;
  const onTime = done.filter((l) => new Date(l.releasedRealAt).getTime() <= new Date(l.tatDueAt).getTime()).length;
  return Math.round((onTime / done.length) * 100);
}

/** Tells the Coordinator what the Lab agent sends, and the clocks and rule it brings. */
@Injectable()
export class LabCoordinatorRegistration implements OnModuleInit {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly orders: LabOrdersService,
    private readonly messages: MessagesService,
    @InjectModel(LabRequest.name) private readonly requests: Model<LabRequestDocument>,
    @InjectModel(LabLine.name) private readonly lines: Model<LabLineDocument>,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.definition());
  }

  private definition(): AgentDefinition {
    return {
      key: 'lab',
      messageTypes: LAB_MESSAGE_TYPES,
      clocks: LAB_CLOCKS,
      handles: [
        { type: 'er.arrived', handler: (id) => this.locate(id, () => ({ area: 'ER' })) },
        { type: 'bed.assigned', handler: (id) => this.locate(id, (p) => ({ area: 'Ward', ward: str(p.ward) ?? undefined })) },
        { type: 'bed.transferred', handler: (id) => this.locate(id, (p) => ({ area: 'Ward', ward: str(p.ward) ?? undefined })) },
        // Leaving the ER for a bed is not a move home: bed.assigned places the patient.
        { type: 'er.left', handler: (id) => this.locate(id, (p) => (p.reason === 'admitted' ? null : { area: 'OPD' })) },
        { type: 'bed.discharged', handler: (id) => this.locate(id, () => ({ area: 'OPD' })) },
      ],
      closeChecks: [{ agent: 'lab', label: 'Lab results released and acknowledged', check: (caseId) => this.closeCheck(caseId) }],
      rules: [
        {
          key: 'critical-lab-escalation',
          agent: 'lab',
          label: 'Critical lab result escalation',
          description: 'Escalate a critical result nobody has acknowledged',
          default: true,
          locked: true,
        },
      ],
      status: async () => ({
        open: await this.lines.countDocuments({ status: { $nin: ['released', 'cancelled'] } }).exec(),
        capacity: 0,
        onTimePct: await labOnTimePct(this.lines, new Date(Date.now() - 24 * 3_600_000)),
      }),
    };
  }

  private async locate(
    messageId: string,
    where: (payload: Record<string, unknown>) => { area: 'ER' | 'Ward' | 'OPD'; ward?: string } | null,
  ): Promise<void> {
    const message = await this.messages.get(messageId);
    if (!message?.case) return;
    const w = where(message.payload ?? {});
    if (w) await this.orders.setLocation(message.case, w.area, w.ward);
  }

  /** 'n/a' with no lab lines on the case; 'pass' when all are released or cancelled and every critical is acknowledged. */
  private async closeCheck(caseId: string): Promise<'pass' | 'fail' | 'n/a'> {
    const ids = await this.requests.find({ case: caseId }).distinct('_id').exec();
    const lines = await this.lines.find({ request: { $in: ids } }).select('status critical').lean<{ status: string; critical?: { active?: boolean; ackAt?: Date } }[]>().exec();
    if (!lines.length) return 'n/a';
    const ok = lines.every((l) => (l.status === 'released' || l.status === 'cancelled') && !(l.critical?.active && !l.critical.ackAt));
    return ok ? 'pass' : 'fail';
  }
}
