import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AgentCallDocument = AgentCall & Document;

export const CALL_PURPOSES = ['confirmation', 'booking'] as const;
export type CallPurpose = (typeof CALL_PURPOSES)[number];

/** scheduled → calling → completed | failed; or canceled before it is placed. */
export const CALL_STATUSES = ['scheduled', 'calling', 'completed', 'failed', 'canceled'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const CALL_OUTCOMES = [
  'confirmed', // confirmation: patient will come
  'rescheduled', // confirmation: moved to one of the offered slots
  'reschedule_requested', // confirmation: wants another time, none of the offered ones
  'cancelled', // confirmation: will not come
  'booked', // booking: took one of the offered slots
  'slot_taken', // the chosen slot was booked by someone else meanwhile
  'callback', // booking: asked to be called at another time
  'declined', // booking: does not want an appointment
  'no_answer',
  'busy',
  'wrong_number',
  'do_not_call', // asked never to be called again
  'escalated', // reported symptoms or asked for a person; staff must call back
  'failed', // the call was not placed, or its result could not be understood
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const CALL_TRIGGERS = ['manual', 'scheduler', 'retry', 'callback'] as const;

@Schema({ _id: false })
export class OfferedSlot {
  @Prop({ required: true })
  date: string; // YYYY-MM-DD

  @Prop({ required: true })
  time: string; // "10:30 AM"

  /** As the agent says it: "Sunday, 27 September at 10:30 AM". */
  @Prop({ required: true })
  label: string;
}

@Schema({ _id: false })
export class TranscriptLine {
  @Prop({ required: true, enum: ['agent', 'patient'] })
  speaker: string;

  @Prop({ required: true })
  text: string;
}

/** What the agent captured during the call. */
@Schema({ _id: false })
export class CallResultData {
  /** 1 or 2: which of `offeredSlots` the patient chose. */
  @Prop()
  chosenSlot?: number;

  @Prop()
  callbackAt?: Date;

  @Prop()
  notes?: string;
}

/** One phone call placed by the AI agent. A retry is a new record with attempt + 1. */
@Schema({ timestamps: true })
export class AgentCall {
  @Prop({ required: true, enum: CALL_PURPOSES, index: true })
  purpose: string;

  @Prop({ default: 'scheduled', enum: CALL_STATUSES, index: true })
  status: string;

  @Prop({ enum: CALL_OUTCOMES })
  outcome?: string;

  @Prop({ required: true, index: true })
  uhid: string;

  @Prop({ required: true })
  patientName: string;

  /** E.164. */
  @Prop({ required: true })
  phone: string;

  /** Confirmation: the appointment being confirmed. Booking: the appointment it created. */
  @Prop({ index: true })
  appointmentId?: string;

  @Prop()
  followUpId?: string;

  @Prop({ default: '' })
  visitReason: string;

  @Prop({ default: '' })
  appointmentType: string;

  @Prop({ required: true, index: true })
  scheduledFor: Date;

  @Prop({ default: 1 })
  attempt: number;

  @Prop({ default: 'manual', enum: CALL_TRIGGERS })
  trigger: string;

  @Prop({ default: '' })
  requestedBy: string;

  @Prop({ required: true })
  provider: string;

  @Prop({ index: true, sparse: true })
  providerCallId?: string;

  /**
   * Set while the call is scheduled or in progress, cleared when it ends. A unique
   * index on it means one appointment (or one patient's booking) can never have two
   * live calls, even when the scheduler and a person trigger one at the same moment.
   */
  @Prop()
  activeKey?: string;

  /** The values the agent's script was filled with. */
  @Prop({ type: Object, default: {} })
  variables: Record<string, string>;

  @Prop({ type: [OfferedSlot], default: [] })
  offeredSlots: OfferedSlot[];

  @Prop({ type: CallResultData, default: {} })
  result: CallResultData;

  @Prop({ default: '' })
  summary: string;

  @Prop({ type: [TranscriptLine], default: [] })
  transcript: TranscriptLine[];

  /** What the system did with the outcome, in words staff can read. */
  @Prop({ default: '' })
  actionTaken: string;

  @Prop()
  startedAt?: Date;

  @Prop()
  endedAt?: Date;

  @Prop()
  durationSec?: number;

  @Prop({ default: '' })
  error: string;
}

export const AgentCallSchema = SchemaFactory.createForClass(AgentCall);
AgentCallSchema.index({ activeKey: 1 }, { unique: true, partialFilterExpression: { activeKey: { $type: 'string' } } });
AgentCallSchema.index({ createdAt: -1 });
