import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PharmacySnapshotDocument = PharmacySnapshot & Document;

/** The Pharmacy agent's five card values at one hour. `hour` is the real clock, so days never collide. */
@Schema({ timestamps: false })
export class PharmacySnapshot {
  /** The real moment, cut to the hour. One snapshot per hour. */
  @Prop({ required: true, unique: true }) hour: Date;
  @Prop({ required: true }) at: Date;
  @Prop({ required: true }) ordersToday: number;
  @Prop({ required: true }) toCheck: number;
  @Prop({ required: true }) openQueries: number;
  @Prop({ required: true }) issuedToday: number;
  @Prop({ required: true }) lowStock: number;
}

export const PharmacySnapshotSchema = SchemaFactory.createForClass(PharmacySnapshot);
