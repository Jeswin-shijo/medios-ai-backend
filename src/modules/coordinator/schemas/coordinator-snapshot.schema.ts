import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CoordinatorSnapshotDocument = CoordinatorSnapshot & Document;

/** The Coordinator's headline counts at one hour. `hour` is the real clock, so days never collide. */
@Schema({ timestamps: false })
export class CoordinatorSnapshot {
  /** The real moment, cut to the hour. One snapshot per hour. */
  @Prop({ required: true, unique: true })
  hour: Date;

  @Prop({ required: true })
  at: Date;

  @Prop({ required: true }) activeWorkflows: number;
  @Prop({ required: true }) agentsOnline: number;
  @Prop({ required: true }) tasksToday: number;
  @Prop({ required: true }) escalations: number;
}

export const CoordinatorSnapshotSchema = SchemaFactory.createForClass(CoordinatorSnapshot);
