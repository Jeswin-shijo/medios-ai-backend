import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CallerLookupDocument = CallerLookup & Document;

/**
 * Failed identity checks per phone number on inbound calls. After a few, lookups for
 * that number stop for a while, so nobody can guess a patient's details by calling
 * again and again.
 */
@Schema()
export class CallerLookup {
  @Prop({ required: true, unique: true })
  phone: string;

  @Prop({ default: 0 })
  failures: number;

  @Prop()
  lockedUntil?: Date;

  @Prop({ required: true })
  expiresAt: Date;
}

export const CallerLookupSchema = SchemaFactory.createForClass(CallerLookup);
CallerLookupSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
