import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DischargeSnapshotDocument = DischargeSnapshot & Document;

@Schema({ _id: false })
export class DischargeCounts {
  @Prop({ default: 0 }) dueToday: number;
  @Prop({ default: 0 }) noOrder: number;
  @Prop({ default: 0 }) clearing: number;
  @Prop({ default: 0 }) ready: number;
  @Prop({ default: 0 }) leftToday: number;
  /** Today's average order-to-leaving minutes; null while nobody has left. */
  @Prop({ type: Number, default: null }) avgMinutes: number | null;
  /** Beds freeing today: open orders leaving today (or late), plus the stays that ended today. */
  @Prop({ default: 0 }) bedsFreeing: number;
}
export const DischargeCountsSchema = SchemaFactory.createForClass(DischargeCounts);

/** An hourly reading for the trend cards. */
@Schema({ timestamps: true })
export class DischargeSnapshot {
  @Prop({ type: Date, required: true, unique: true })
  at: Date;

  @Prop({ type: DischargeCountsSchema, default: () => ({}) })
  counts: DischargeCounts;
}

export const DischargeSnapshotSchema = SchemaFactory.createForClass(DischargeSnapshot);
