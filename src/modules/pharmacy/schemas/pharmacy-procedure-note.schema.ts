import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type PharmacyProcedureNoteDocument = PharmacyProcedureNote & Document;

export const PROCEDURE_NOTE_STATUSES = ['booked', 'done', 'cancelled'] as const;
export type ProcedureNoteStatus = (typeof PROCEDURE_NOTE_STATUSES)[number];

/**
 * What Pharmacy knows about a contrast procedure booked for a patient, learnt only from Scheduling's messages.
 * `start` is a clinic-clock Date, as in the message.
 */
@Schema({ timestamps: true })
export class PharmacyProcedureNote {
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId, index: true }) patient: Types.ObjectId;
  @Prop({ required: true, unique: true }) bookingId: string;
  @Prop({ required: true }) number: string;
  @Prop({ required: true }) procedure: string;
  @Prop({ required: true, default: true }) contrast: boolean;
  @Prop({ required: true, type: Date }) start: Date;
  @Prop({ required: true, type: String, enum: PROCEDURE_NOTE_STATUSES, default: 'booked' }) status: ProcedureNoteStatus;
}

export const PharmacyProcedureNoteSchema = SchemaFactory.createForClass(PharmacyProcedureNote);
