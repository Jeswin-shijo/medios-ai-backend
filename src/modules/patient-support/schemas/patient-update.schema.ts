import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { UPDATE_STATUSES } from '../support-catalogue';

export type PatientUpdateDocument = PatientUpdate & Document;

/** One family update: made from an event, filled from an approved template, sent (or held or skipped) on the minute pass. */
@Schema({ timestamps: true })
export class PatientUpdate {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) patient: Types.ObjectId;
  @Prop({ required: true }) patientUhid: string;
  @Prop({ required: true }) patientName: string;
  @Prop({ type: MongooseSchema.Types.ObjectId }) case?: Types.ObjectId;

  @Prop({ required: true }) trigger: string;
  /** Once per event: `<trigger>:<source id>`. */
  @Prop({ required: true, unique: true }) dedupeKey: string;
  @Prop({ type: MongooseSchema.Types.ObjectId }) sourceMessage?: Types.ObjectId;
  @Prop({ default: '' }) sourceRef: string;

  @Prop({ required: true }) template: string;
  @Prop({ required: true, default: 'en' }) language: string;
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) values: Record<string, string>;
  @Prop({ default: '' }) text: string;

  /** E.164. */
  @Prop() to?: string;
  /** "Self" or "Son (Ravi)". */
  @Prop({ default: '' }) toLabel: string;
  @Prop({ type: String, required: true, default: 'message' }) channel: 'message';

  @Prop({ required: true, enum: UPDATE_STATUSES }) status: string;
  @Prop() reason?: string;
  @Prop() note?: string;
  @Prop({ type: Date }) sendAt?: Date;
  @Prop({ type: Date }) sentAt?: Date;

  /** Message ids already sent to the Coordinator for this update. */
  @Prop({ type: [String], default: [] }) announced: string[];
}

export const PatientUpdateSchema = SchemaFactory.createForClass(PatientUpdate);
PatientUpdateSchema.index({ status: 1, sendAt: 1 });
PatientUpdateSchema.index({ patient: 1, createdAt: -1 });
