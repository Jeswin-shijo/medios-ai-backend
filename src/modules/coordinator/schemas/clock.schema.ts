import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type ClockDocument = Clock & Document;

export const CLOCK_STATES = ['running', 'met', 'expired'] as const;
export type ClockState = (typeof CLOCK_STATES)[number];

/** A deadline running for one definition and case. Real time, not the clinic clock. */
@Schema({ timestamps: true })
export class Clock {
  @Prop({ required: true }) def: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null }) case?: Types.ObjectId | null;
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId }) startedBy: Types.ObjectId;
  @Prop({ required: true, type: Date }) startedAt: Date;
  @Prop({ required: true, type: Date }) dueAt: Date;
  @Prop({ type: String, default: 'running', enum: CLOCK_STATES }) state: ClockState;
  /** The item the clock is for (a request or a line), or null for one clock per case. */
  @Prop({ type: String, default: null }) ref?: string | null;
  @Prop({ type: Date }) stoppedAt?: Date;
  @Prop({ type: Number }) metMinutes?: number;
  @Prop({ type: MongooseSchema.Types.ObjectId }) escalation?: Types.ObjectId;
  /** What the clock is about, from the definition's detailFrom (e.g. "LR-0019 · Troponin I"). Never a patient name. */
  @Prop() detail?: string;
}

export const ClockSchema = SchemaFactory.createForClass(Clock);
// One running clock per definition, case and item; met and expired clocks stay as history.
ClockSchema.index({ def: 1, case: 1, ref: 1 }, { unique: true, partialFilterExpression: { state: { $eq: 'running' } } });
ClockSchema.index({ state: 1, dueAt: 1 });
