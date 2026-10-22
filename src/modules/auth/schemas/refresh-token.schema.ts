import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type RefreshTokenDocument = RefreshToken & Document;

/**
 * One refresh token. Only its SHA-256 hash is stored, so a database leak does not
 * leak usable tokens. Every rotation of one sign-in shares a `family`; presenting a
 * token that was already rotated revokes the whole family (likely theft).
 */
@Schema({ timestamps: true })
export class RefreshToken {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ required: true, unique: true })
  tokenHash: string;

  @Prop({ required: true, index: true })
  family: string;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ type: Date, default: null })
  revokedAt: Date | null;

  /** Hash of the token this one was rotated into. */
  @Prop({ default: '' })
  replacedBy: string;

  @Prop({ default: '' })
  userAgent: string;

  @Prop({ default: '' })
  ip: string;
}

export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken);
// MongoDB removes expired tokens on its own.
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
