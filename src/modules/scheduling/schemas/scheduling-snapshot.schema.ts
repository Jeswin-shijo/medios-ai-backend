import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SchedulingSnapshotDocument = SchedulingSnapshot & Document;

/** The Scheduling agent's card values at one hour. `hour` is the real clock, so days never collide. */
@Schema({ timestamps: false })
export class SchedulingSnapshot {
  /** The real moment, cut to the hour. One snapshot per hour. */
  @Prop({ required: true, unique: true }) hour: Date;
  @Prop({ required: true }) at: Date;
  @Prop({ required: true }) proceduresToday: number;
  @Prop({ required: true }) openConsults: number;
  @Prop({ required: true }) cantBook: number;
  @Prop({ required: true }) waitlist: number;
  @Prop({ required: true }) appointmentsToday: number;
}

export const SchedulingSnapshotSchema = SchemaFactory.createForClass(SchedulingSnapshot);
