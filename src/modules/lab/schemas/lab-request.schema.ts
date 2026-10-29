import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type LabRequestDocument = LabRequest & Document;
export const LAB_PRIORITIES = ['stat', 'urgent', 'routine'] as const;

/** One doctor's order of tests for a patient, all at one priority. */
@Schema({ timestamps: true })
export class LabRequest {
  @Prop({ required: true, unique: true }) number: string;
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId, ref: 'Patient', index: true }) patient: Types.ObjectId;
  @Prop({ required: true }) patientUhid: string;
  @Prop({ required: true }) patientName: string;
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId, index: true }) case: Types.ObjectId;
  @Prop({ required: true, type: { id: String, name: String }, _id: false }) orderedBy: { id: string; name: string };
  @Prop({ required: true, type: String, enum: LAB_PRIORITIES }) priority: 'stat' | 'urgent' | 'routine';
  @Prop({ default: '' }) note: string;
  /** Clinic clock. */
  @Prop({ required: true, type: Date }) orderedAt: Date;
  /** Real time. */
  @Prop({ required: true, type: Date }) collectBy: Date;
  @Prop({ type: MongooseSchema.Types.ObjectId }) repeatOf?: Types.ObjectId;
  /** Real time: when a repeat is due. */
  @Prop({ type: Date }) scheduledFor?: Date;
  /** Set after the Coordinator message went out; the reconcile pass reads them. */
  @Prop({ type: Date }) announcedAt?: Date;
  @Prop({ type: Date }) collectionDoneAt?: Date;
  @Prop({ type: Date }) doneAt?: Date;
  /** Real time: set by the first sample received, so only one receipt starts the turnaround clock. */
  @Prop({ type: Date }) firstReceivedAt?: Date;
}

export const LabRequestSchema = SchemaFactory.createForClass(LabRequest);
LabRequestSchema.index({ doneAt: 1 });
LabRequestSchema.index({ announcedAt: 1 });
