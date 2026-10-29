import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentRegistry } from '../coordinator/agent-registry';
import { AgentDefinition, ClockDef, MessageTypeDef } from '../coordinator/coordinator-types';
import { MessagesService } from '../coordinator/messages.service';
import { LabOrdersService } from './lab-orders.service';
import { LabLine, LabLineDocument } from './schemas/lab-line.schema';
import { LabRequest, LabRequestDocument } from './schemas/lab-request.schema';

const type = (t: string, description: string, payload: MessageTypeDef['payload']): MessageTypeDef => ({
  type: t,
  agent: 'lab',
  description,
  payload,
});

const MESSAGE_TYPES: MessageTypeDef[] = [
  type('lab.ordered', 'Lab tests were ordered', { requestId: 'string', requestNumber: 'string', priority: 'string', tests: 'string[]', collectBy: 'date', tatDueAt: 'date' }),
  type('lab.cancelled', 'A lab test was cancelled', { requestId: 'string', lineId: 'string', test: 'string', reason: 'string', tatDueAt: 'date' }),
  type('lab.collected', 'A sample was collected', { requestId: 'string', sampleId: 'string', sampleNumber: 'string', tube: 'string', tests: 'string[]' }),
  type('lab.collection-done', 'Every sample for a request was collected', { requestId: 'string' }),
  type('lab.received', 'A sample reached the lab', { requestId: 'string', sampleId: 'string', firstReceive: 'boolean', tatDueAt: 'date' }),
  type('lab.rejected', 'A sample was rejected and needs recollecting', { requestId: 'string', sampleId: 'string', newSampleId: 'string', reason: 'string', recollectBy: 'date' }),
  type('lab.resulted', 'A lab result was released', { requestId: 'string', lineId: 'string', test: 'string', flag: 'string', version: 'number', tatDueAt: 'date' }),
  type('lab.request-done', 'Every test on a request is finished', { requestId: 'string' }),
  type('lab.critical', 'A critical lab value was found', { requestId: 'string', lineId: 'string', test: 'string', parameter: 'string', value: 'string', unit: 'string', version: 'number' }),
  type('lab.critical-acked', 'A doctor acknowledged a critical value', { lineId: 'string' }),
];

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const date = (key: string) => (payload: Record<string, unknown>): Date | null => {
  const v = payload[key];
  const d = typeof v === 'string' || v instanceof Date ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d : null;
};
const byRequest = (_t: string, p: Record<string, unknown>) => str(p.requestId);

const CLOCKS: ClockDef[] = [
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
    dueFrom: date('tatDueAt'),
    refFrom: byRequest,
    updateOn: ['lab.resulted', 'lab.cancelled'],
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
  },
];

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
      messageTypes: MESSAGE_TYPES,
      clocks: CLOCKS,
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
      status: async () => ({ open: 0, capacity: 0, onTimePct: null }),
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
