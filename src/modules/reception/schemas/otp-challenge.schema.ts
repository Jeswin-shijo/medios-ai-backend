import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type OtpChallengeDocument = OtpChallenge & Document;

/**
 * One row per lookup at a kiosk. A row with a code is a send; a row without one
 * records a lookup for a number nobody has, so guessing numbers still counts
 * against the kiosk's hourly limit. Rows live an hour (the longest limit window);
 * the code itself is only valid until `validUntil`.
 */
@Schema({ timestamps: true })
export class OtpChallenge {
  @Prop({ required: true })
  phone10: string;

  @Prop({ required: true, index: true })
  kioskId: string;

  /** False for a lookup that found no patient; no code was made. */
  @Prop({ required: true })
  found: boolean;

  /** HMAC-SHA256 of `phone10:code`; empty when no code was made. */
  @Prop({ default: '' })
  codeHash: string;

  @Prop({ required: true })
  sentAt: Date;

  @Prop({ required: true })
  validUntil: Date;

  @Prop({ default: 0 })
  attempts: number;

  /** Used, replaced by a newer code, or locked after too many wrong tries. */
  @Prop({ default: false })
  closed: boolean;

  @Prop({ required: true })
  expiresAt: Date;
}

export const OtpChallengeSchema = SchemaFactory.createForClass(OtpChallenge);
OtpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// One open code per number: concurrent sends race on this index and the losers wait.
OtpChallengeSchema.index({ phone10: 1 }, { unique: true, partialFilterExpression: { found: true, closed: false } });
OtpChallengeSchema.index({ phone10: 1, sentAt: -1 });
