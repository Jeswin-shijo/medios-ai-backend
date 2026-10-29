import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CallerLookupDocument = CallerLookup & Document;

/**
 * Failed identity checks per phone number on inbound calls. After a few, lookups for
 * that number stop for a while, and each lock within a day lasts longer, so nobody
 * can guess a patient's details by calling again and again.
 */
@Schema()
export class CallerLookup {
  @Prop({ required: true, unique: true })
  phone: string;

  /** Failed checks since the count last lapsed. A success does not clear it. */
  @Prop({ default: 0 })
  failures: number;

  /** When the count lapses: 30 minutes after the last failure. */
  @Prop()
  failuresUntil?: Date;

  /** Locks within the last 24 hours (30 minutes, then 2 hours, then 24 hours). */
  @Prop({ default: 0 })
  locks: number;

  /** When the lock count lapses: 24 hours after the last lock. */
  @Prop()
  locksUntil?: Date;

  @Prop()
  lockedUntil?: Date;

  /** The document is removed once the count, the lock and the lock count have all lapsed. */
  @Prop({ required: true })
  expiresAt: Date;
}

export const CallerLookupSchema = SchemaFactory.createForClass(CallerLookup);
CallerLookupSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
