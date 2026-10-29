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
  @Prop({ type: Date }) stoppedAt?: Date;
  @Prop({ type: Number }) metMinutes?: number;
  @Prop({ type: MongooseSchema.Types.ObjectId }) escalation?: Types.ObjectId;
}

export const ClockSchema = SchemaFactory.createForClass(Clock);
// One running clock per definition and case; met and expired clocks stay as history.
ClockSchema.index({ def: 1, case: 1 }, { unique: true, partialFilterExpression: { state: { $eq: 'running' } } });
ClockSchema.index({ state: 1, dueAt: 1 });
