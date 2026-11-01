import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { clinicNow, isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import { AgentRegistry } from '../coordinator/agent-registry';
import { AgentDefinition, ClockDef, MessageTypeDef } from '../coordinator/coordinator-types';
import { MessagesService } from '../coordinator/messages.service';
import { Clock, ClockDocument } from '../coordinator/schemas/clock.schema';
import { ConsultRequest, ConsultRequestDocument } from './schemas/consult-request.schema';
import { SchedulingConsultsService } from './scheduling-consults.service';
import { ProcedureBooking, ProcedureBookingDocument } from './schemas/procedure-booking.schema';

type Fields = MessageTypeDef['payload'];

const type = (t: string, description: string, payload: Fields): MessageTypeDef => ({ type: t, agent: 'scheduling', description, payload });

const PROCEDURE: Fields = { bookingId: 'string', number: 'string', procedure: 'string', priority: 'string', status: 'string' };
const CONSULT: Fields = { consultId: 'string', number: 'string', department: 'string', priority: 'string', dueAt: 'date' };

const MESSAGE_TYPES: MessageTypeDef[] = [
  type('scheduling.procedure-requested', 'A procedure was requested', PROCEDURE),
  type('scheduling.procedure-booked', 'A procedure was booked into a room', { ...PROCEDURE, room: 'string', start: 'date', contrast: 'boolean' }),
  type('scheduling.procedure-bumped', 'A planned procedure was moved to make way for an emergency', PROCEDURE),
  type('scheduling.procedure-started', 'A procedure started', PROCEDURE),
  type('scheduling.procedure-done', 'A procedure was done', PROCEDURE),
  type('scheduling.procedure-cancelled', 'A procedure was cancelled', PROCEDURE),
  type('scheduling.procedure-cant-book', 'A procedure could not be booked yet', { ...PROCEDURE, dueAt: 'date' }),
  type('scheduling.consult-requested', 'A consult was requested', CONSULT),
  type('scheduling.consult-paged', 'The on-call doctor was paged for a consult', CONSULT),
  type('scheduling.consult-accepted', 'A doctor accepted a consult', CONSULT),
  type('scheduling.consult-seen', 'The patient was seen for a consult', CONSULT),
  type('scheduling.consult-cancelled', 'A consult was cancelled', CONSULT),
  type('scheduling.followup-booked', 'A follow-up appointment was booked', { appointmentId: 'string', date: 'string', time: 'string', doctor: 'string' }),
];

export const SCHEDULING_MESSAGE_TYPES = MESSAGE_TYPES;

const LEAVING = ['home', 'transfer', 'left-against-advice', 'died'];
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const dueAt = (payload: Record<string, unknown>): Date | null => {
  const v = payload.dueAt;
  const d = typeof v === 'string' || v instanceof Date ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d : null;
};

/** Exported for the demo seed, so seeded clocks carry the same detail the live ones do. */
export const SCHEDULING_CLOCKS: ClockDef[] = [
  {
    key: 'scheduling-consult',
    agent: 'scheduling',
    label: 'Consult seen',
    startOn: 'scheduling.consult-requested',
    stopOn: ['scheduling.consult-seen', 'scheduling.consult-cancelled'],
    minutes: 1440,
    ladder: 'consult',
    dueFrom: dueAt,
    refFrom: (_t, p) => str(p.consultId),
    resolveEscalationOnStop: true,
    resolvedBy: 'Consult seen',
    alertLink: (ref) => (ref ? `scheduling-consult:${ref}` : null),
    detailFrom: (p) => {
      const number = str(p.number);
      const department = str(p.department);
      return number && department ? `${number} ${department}` : number;
    },
  },
  {
    key: 'scheduling-booking',
    agent: 'scheduling',
    label: 'Procedure booking wait',
    startOn: 'scheduling.procedure-cant-book',
    stopOn: ['scheduling.procedure-booked', 'scheduling.procedure-cancelled'],
    minutes: 120,
    ladder: 'default',
    // Only a STAT or urgent request waits on a clock; a routine one waits quietly.
    match: (t, p) => t !== 'scheduling.procedure-cant-book' || p.priority === 'stat' || p.priority === 'urgent',
    dueFrom: dueAt,
    refFrom: (_t, p) => str(p.bookingId),
  },
];

/** The share of Consult seen clocks stopped since `since` that were met in time; null when none stopped. */
export async function consultOnTimePct(clocks: Model<ClockDocument>, since: Date): Promise<number | null> {
  const stopped = await clocks.find({ def: 'scheduling-consult', stoppedAt: { $gte: since } }).select('state').lean<{ state: string }[]>().exec();
  if (!stopped.length) return null;
  return Math.round((stopped.filter((c) => c.state === 'met').length / stopped.length) * 100);
}

/** Tells the Coordinator what the Scheduling agent sends, and the clocks, rule and close check it brings. */
@Injectable()
export class SchedulingCoordinatorRegistration implements OnModuleInit {
  constructor(
    private readonly registry: AgentRegistry,
    @InjectModel(ConsultRequest.name) private readonly consults: Model<ConsultRequestDocument>,
    @InjectModel(ProcedureBooking.name) private readonly bookings: Model<ProcedureBookingDocument>,
    @InjectModel(Clock.name) private readonly clocks: Model<ClockDocument>,
    private readonly consultsService: SchedulingConsultsService,
    private readonly messages: MessagesService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.definition());
  }

  private definition(): AgentDefinition {
    return {
      key: 'scheduling',
      messageTypes: MESSAGE_TYPES,
      clocks: SCHEDULING_CLOCKS,
      handles: [
        // Admit keeps the consult open: the patient is still in the hospital.
        { type: 'er.disposition', handler: (id) => this.patientLeft(id, (p) => LEAVING.includes(String(p.kind))) },
        { type: 'bed.discharged', handler: (id) => this.patientLeft(id, () => true) },
      ],
      rules: [
        {
          key: 'emergency-bump',
          agent: 'scheduling',
          label: 'Emergencies may bump planned procedures',
          description: 'Let a STAT procedure take the room of a planned one, which then waits for a new time',
          default: true,
        },
      ],
      closeChecks: [{ agent: 'scheduling', label: 'Procedures and consults finished', check: (caseId) => this.closeCheck(caseId) }],
      status: async () => {
        // "Today" is the clinic day.
        const start = parseIsoDay(isoDate(clinicNow()));
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        const [consults, booked, cantBook] = await Promise.all([
          this.consults.countDocuments({ status: { $in: ['paged', 'accepted'] } }).exec(),
          this.bookings.countDocuments({ status: { $in: ['booked', 'in-progress'] }, start: { $gte: start, $lt: end } }).exec(),
          this.bookings.countDocuments({ status: 'cant-book', earliest: { $lt: end } }).exec(),
        ]);
        return { open: consults + booked + cantBook, capacity: 0, onTimePct: await consultOnTimePct(this.clocks, new Date(Date.now() - 24 * 3_600_000)) };
      },
    };
  }

  /** Cancels the open consults on the message's case when `leaving` says the patient has left; a message with no case is skipped. */
  private async patientLeft(messageId: string, leaving: (payload: Record<string, unknown>) => boolean): Promise<void> {
    const message = await this.messages.get(messageId);
    if (!message?.case || !leaving(message.payload ?? {})) return;
    await this.consultsService.onPatientLeft(String(message.case), 'Patient left');
  }

  /** 'fail' while a consult is paged or accepted, or a procedure is booked or in progress; 'pass' once some are finished; else 'n/a'. */
  private async closeCheck(caseId: string): Promise<'pass' | 'fail' | 'n/a'> {
    const [consults, procedures] = await Promise.all([
      this.consults.find({ case: caseId }).select('status').lean<{ status: string }[]>().exec(),
      this.bookings.find({ case: caseId }).select('status').lean<{ status: string }[]>().exec(),
    ]);
    if (consults.some((c) => c.status === 'paged' || c.status === 'accepted')) return 'fail';
    if (procedures.some((p) => p.status === 'booked' || p.status === 'in-progress')) return 'fail';
    if (consults.some((c) => c.status === 'seen') || procedures.some((p) => p.status === 'done')) return 'pass';
    return 'n/a';
  }
}
