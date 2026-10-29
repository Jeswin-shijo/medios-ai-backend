import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentRegistry } from '../coordinator/agent-registry';
import { AgentDefinition, ClockDef, MessageTypeDef } from '../coordinator/coordinator-types';
import { Clock, ClockDocument } from '../coordinator/schemas/clock.schema';
import { MessagesService } from '../coordinator/messages.service';
import { ErBaysService } from './er-bays.service';
import { PATHWAYS, PathwayKey, StepKey } from './er-rules';
import { ErVisitsService } from './er-visits.service';
import { ErVisit, ErVisitDocument, OPEN_ER_STATUSES } from './schemas/er-visit.schema';

const TRIAGE_MINUTES = 10;
const DAY_MS = 24 * 60 * 60_000;

const type = (t: string, description: string, payload: MessageTypeDef['payload']): MessageTypeDef => ({
  type: t,
  agent: 'er',
  description,
  payload,
});

const MESSAGE_TYPES: MessageTypeDef[] = [
  type('er.expected', 'A patient is on the way to the ER', { expectedId: 'string', complaint: 'string' }),
  type('er.arrived', 'A patient arrived in the ER', { visitId: 'string', visitNumber: 'string', complaint: 'string' }),
  type('er.triaged', 'Triage was confirmed', { visitId: 'string', colour: 'string', doctorDueAt: 'date' }),
  type('er.retriaged', 'The triage colour was changed', { visitId: 'string', colour: 'string', doctorDueAt: 'date' }),
  type('er.pathway-started', 'A fast-track pathway started', { visitId: 'string', pathway: 'string', stepDue: 'object', doctorDueAt: 'date' }),
  type('er.pathway-cancelled', 'A fast-track pathway was cancelled', { visitId: 'string', pathway: 'string', doctorDueAt: 'date' }),
  type('er.step-done', 'A pathway step was done', { visitId: 'string', step: 'string' }),
  type('er.doctor-seen', 'A doctor saw the patient', { visitId: 'string' }),
  type('er.disposition', 'The doctor decided what happens next', { visitId: 'string', kind: 'string' }),
  type('er.left', 'The patient left the ER', { visitId: 'string', reason: 'string' }),
];

/** Every non-doctor pathway step has its own clock: the doctor steps all fold into `er-doctor`. */
const STEP_CLOCKS: ClockDef[] = (Object.keys(PATHWAYS) as PathwayKey[]).flatMap((pathway) =>
  PATHWAYS[pathway].steps
    .filter((s) => s.key !== 'doctor')
    .map((s): ClockDef => {
      const step: StepKey = s.key;
      return {
        key: `er-step-${step}`,
        agent: 'er',
        label: s.label,
        startOn: 'er.pathway-started',
        stopOn: ['er.step-done', 'er.pathway-cancelled', 'er.left'],
        minutes: s.defaultMin,
        ladder: 'er',
        match: (t, payload) => {
          // A step done before a restart is left out of stepDue, so it gets no fresh clock.
          if (t === 'er.pathway-started') {
            const due = payload.stepDue as Record<string, unknown> | undefined;
            return payload.pathway === pathway && due != null && due[step] != null;
          }
          if (t === 'er.pathway-cancelled') return payload.pathway === pathway;
          if (t === 'er.step-done') return payload.step === step;
          return true;
        },
        dueFrom: (payload) => {
          const due = (payload.stepDue as Record<string, unknown> | undefined)?.[step];
          const d = typeof due === 'string' || due instanceof Date ? new Date(due) : null;
          return d && !isNaN(d.getTime()) ? d : null;
        },
      };
    }),
);

const doctorDue = (payload: Record<string, unknown>): Date | null => {
  const v = payload.doctorDueAt;
  const d = typeof v === 'string' || v instanceof Date ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d : null;
};

/**
 * The share of doctor reviews done by their due time, among those finished since `since` (a real
 * time, not the clinic clock). A review closed by the patient leaving counts too. Null when none.
 */
export async function erOnTimePct(clocks: Model<ClockDocument>, since: Date): Promise<number | null> {
  const done = await clocks
    .find({ def: 'er-doctor', stoppedAt: { $gte: since } })
    .select('dueAt stoppedAt')
    .lean<{ dueAt: Date; stoppedAt: Date }[]>()
    .exec();
  if (!done.length) return null;
  const onTime = done.filter((c) => c.stoppedAt.getTime() <= c.dueAt.getTime()).length;
  return Math.round((onTime / done.length) * 100);
}

/** Tells the Coordinator what the ER agent sends, and the clocks and rule it brings. */
@Injectable()
export class ErCoordinatorRegistration implements OnModuleInit {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly visitsService: ErVisitsService,
    private readonly bays: ErBaysService,
    private readonly messages: MessagesService,
    @InjectModel(ErVisit.name) private readonly visits: Model<ErVisitDocument>,
    @InjectModel(Clock.name) private readonly clocks: Model<ClockDocument>,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.definition());
  }

  private definition(): AgentDefinition {
    return {
      key: 'er',
      messageTypes: MESSAGE_TYPES,
      clocks: [
        {
          key: 'er-triage',
          agent: 'er',
          label: 'Triage',
          startOn: 'er.arrived',
          stopOn: ['er.triaged', 'er.left'],
          minutes: TRIAGE_MINUTES,
          ladder: 'er',
        },
        {
          key: 'er-doctor',
          agent: 'er',
          label: 'Doctor review',
          startOn: 'er.triaged',
          stopOn: ['er.doctor-seen', 'er.left'],
          minutes: 30,
          ladder: 'er',
          dueFrom: doctorDue,
          updateOn: ['er.retriaged', 'er.pathway-started', 'er.pathway-cancelled'],
        },
        ...STEP_CLOCKS,
      ],
      handles: [
        { type: 'bed.assigned', handler: (messageId) => this.onBedAssigned(messageId) },
        { type: 'bed.cancelled', handler: (messageId) => this.onBedCancelled(messageId) },
      ],
      closeChecks: [{ agent: 'er', label: 'ER visit finished', check: (caseId) => this.closeCheck(caseId) }],
      rules: [
        {
          key: 'er-auto-pathways',
          agent: 'er',
          label: 'Start pathways automatically',
          description: 'Start the chest-pain, stroke and sepsis pathways from the complaint and vitals',
          default: true,
        },
      ],
      status: () => this.status(),
    };
  }

  /** The Bed Agent placed the patient on this message's case. */
  private async onBedAssigned(messageId: string): Promise<void> {
    const message = await this.messages.get(messageId);
    if (message?.case) await this.visitsService.onBedAssigned(message.case);
  }

  /** A bed request on this message's case was cancelled: a visit waiting for that bed goes back to treatment. */
  private async onBedCancelled(messageId: string): Promise<void> {
    const message = await this.messages.get(messageId);
    if (message?.case) await this.visitsService.onBedCancelled(message.case);
  }

  /** 'n/a' with no ER visit on the case; 'pass' when every one has left. */
  private async closeCheck(caseId: string): Promise<'pass' | 'fail' | 'n/a'> {
    const statuses = await this.visits.find({ case: caseId }).select('status').lean<{ status: string }[]>().exec();
    if (!statuses.length) return 'n/a';
    return statuses.every((v) => v.status === 'left') ? 'pass' : 'fail';
  }

  private async status() {
    const [open, capacity, onTimePct] = await Promise.all([
      this.visits.countDocuments({ status: { $in: [...OPEN_ER_STATUSES] } }).exec(),
      this.bays.countInUse(),
      erOnTimePct(this.clocks, new Date(Date.now() - DAY_MS)),
    ]);
    return { open, capacity, onTimePct };
  }
}
