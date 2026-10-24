import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PatientCardDocument = PatientCard & Document;

/**
 * A hospital card linked to a patient. Nothing is written to the card: `cardId` is
 * the card's factory serial number exactly as the USB reader types it (normalised).
 * A basic card's serial can be copied, so a tap only identifies the patient for a
 * queue token; it never opens their records.
 */
@Schema({ timestamps: true })
export class PatientCard {
  @Prop({ required: true, unique: true })
  cardId: string;

  @Prop({ required: true, index: true })
  uhid: string;

  @Prop({ default: '' })
  linkedBy: string;

  @Prop()
  lastUsedAt?: Date;
}

export const PatientCardSchema = SchemaFactory.createForClass(PatientCard);
