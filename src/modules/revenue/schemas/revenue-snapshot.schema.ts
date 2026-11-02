import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RevenueSnapshotDocument = RevenueSnapshot & Document;

/** An hourly reading for the trend cards. */
@Schema({ timestamps: true })
export class RevenueSnapshot {
  @Prop({ type: Date, required: true, unique: true })
  at: Date;

  @Prop({ default: 0 }) collected: number;
  @Prop({ default: 0 }) openBills: number;
  @Prop({ default: 0 }) depositsDue: number;
  @Prop({ default: 0 }) finalWaiting: number;
  @Prop({ default: 0 }) refundsDue: number;
}

export const RevenueSnapshotSchema = SchemaFactory.createForClass(RevenueSnapshot);
