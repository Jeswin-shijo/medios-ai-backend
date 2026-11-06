import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PatientCardDocument = PatientCard & Document;

export type PatientCardStatus = 'active' | 'replaced';

/**
 * A hospital card linked to a patient. `cardId` is the card's factory serial number
 * exactly as the reader gives it (normalised); it alone identifies the card. The
 * counter tablet may also write the UHID onto the card as text, but that text is
 * never read for identification. A basic card's serial can be copied, so a tap
 * only identifies the patient for a queue token; it never opens their records.
 *
 * A patient has one active card: linking a new one marks the older ones replaced
 * (kept for history), and a replaced card is refused everywhere.
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

  /** Cards linked before status existed have none and count as active. */
  @Prop({ type: String, enum: ['active', 'replaced'], default: 'active' })
  status: PatientCardStatus;

  /**
   * When the card was last linked to its patient, set on every (re)link. No default:
   * a card linked before this existed counts from its `createdAt`.
   */
  @Prop()
  linkedAt?: Date;

  /** When the counter tablet last wrote the patient's details onto the card. */
  @Prop()
  writtenAt?: Date;

  @Prop()
  replacedAt?: Date;
}

export const PatientCardSchema = SchemaFactory.createForClass(PatientCard);
PatientCardSchema.index({ uhid: 1, status: 1 });
