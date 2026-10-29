import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LabSnapshotDocument = LabSnapshot & Document;

/** The Lab agent's five card values at one hour. `hour` is the real clock, so days never collide. */
@Schema({ timestamps: false })
export class LabSnapshot {
  /** The real moment, cut to the hour. One snapshot per hour. */
  @Prop({ required: true, unique: true }) hour: Date;
  @Prop({ required: true }) at: Date;
  @Prop({ required: true }) ordersToday: number;
  @Prop({ required: true }) samplesCollected: number;
  @Prop({ required: true }) inProcessing: number;
  @Prop({ required: true }) resultsCompleted: number;
  @Prop({ required: true }) criticalResults: number;
}

export const LabSnapshotSchema = SchemaFactory.createForClass(LabSnapshot);
