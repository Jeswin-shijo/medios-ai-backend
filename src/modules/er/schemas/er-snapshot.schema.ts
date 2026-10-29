import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ErSnapshotDocument = ErSnapshot & Document;

/** The ER's headline numbers at one hour. `hour` is the real clock, so days never collide. */
@Schema({ timestamps: false })
export class ErSnapshot {
  /** The real moment, cut to the hour. One snapshot per hour. */
  @Prop({ required: true, unique: true })
  hour: Date;

  @Prop({ required: true })
  at: Date;

  @Prop({ required: true }) patientsInEr: number;
  @Prop({ required: true }) critical: number;
  /** Null when nobody was triaged today yet. */
  @Prop({ type: Number, default: null }) avgTriageMin: number | null;
  /** Null when no doctor review finished today yet. */
  @Prop({ type: Number, default: null }) onTimePct: number | null;
}

export const ErSnapshotSchema = SchemaFactory.createForClass(ErSnapshot);
