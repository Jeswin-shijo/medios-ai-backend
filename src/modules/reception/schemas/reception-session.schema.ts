import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ReceptionSessionDocument = ReceptionSession & Document;

/** An identified patient at one kiosk. The opaque token itself is never stored, only its hash. */
@Schema({ timestamps: true })
export class ReceptionSession {
  @Prop({ required: true, unique: true })
  tokenHash: string;

  @Prop({ required: true })
  uhid: string;

  @Prop({ required: true })
  kioskId: string;

  @Prop({ required: true, enum: ['card', 'otp', 'register'] })
  via: string;

  @Prop({ required: true })
  expiresAt: Date;
}

export const ReceptionSessionSchema = SchemaFactory.createForClass(ReceptionSession);
ReceptionSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
