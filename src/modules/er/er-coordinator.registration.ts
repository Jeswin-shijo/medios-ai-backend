import { Injectable, OnModuleInit } from '@nestjs/common';
import { AgentRegistry } from '../coordinator/agent-registry';
import { AgentDefinition, ClockDef, MessageTypeDef } from '../coordinator/coordinator-types';
import { PATHWAYS, PathwayKey, StepKey } from './er-rules';

const TRIAGE_MINUTES = 10;

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
          if (t === 'er.pathway-started' || t === 'er.pathway-cancelled') return payload.pathway === pathway;
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

/** Tells the Coordinator what the ER agent sends, and the clocks and rule it brings. */
@Injectable()
export class ErCoordinatorRegistration implements OnModuleInit {
  constructor(private readonly registry: AgentRegistry) {}

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
      rules: [
        {
          key: 'er-auto-pathways',
          agent: 'er',
          label: 'Start pathways automatically',
          description: 'Start the chest-pain, stroke and sepsis pathways from the complaint and vitals',
          default: true,
        },
      ],
      // Task 5 fills in the real numbers.
      status: async () => ({ open: 0, capacity: 0, onTimePct: null }),
    };
  }
}
