import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SchedulingLockDocument = SchedulingLock & Document;

/** A short claim, so only one caller plans and saves procedure bookings at a time. Real time. */
@Schema({ timestamps: false })
export class SchedulingLock {
  @Prop({ required: true, unique: true }) key: string;
  /** The claim lapses at this moment, so a crashed holder never blocks booking for long. */
  @Prop({ required: true, type: Date }) until: Date;
}

export const SchedulingLockSchema = SchemaFactory.createForClass(SchedulingLock);
