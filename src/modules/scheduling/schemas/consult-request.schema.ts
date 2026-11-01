import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type ConsultRequestDocument = ConsultRequest & Document & { createdAt?: Date; updatedAt?: Date };
export const CONSULT_STATUSES = ['paged', 'accepted', 'seen', 'cancelled'] as const;
export type ConsultStatus = (typeof CONSULT_STATUSES)[number];

/** A request for a specialist to see an inpatient or ER patient. */
@Schema({ timestamps: true })
export class ConsultRequest {
  /** CO-0001 */
  @Prop({ required: true, unique: true }) number: string;
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId, ref: 'Patient', index: true }) patient: Types.ObjectId;
  @Prop({ required: true }) patientUhid: string;
  @Prop({ required: true }) patientName: string;
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId, index: true }) case: Types.ObjectId;
  @Prop({ required: true }) departmentCode: string;
  @Prop({ required: true, type: String, enum: ['stat', 'urgent', 'routine'] }) priority: 'stat' | 'urgent' | 'routine';
  @Prop({ default: '' }) reason: string;
  @Prop({ required: true, type: String, enum: CONSULT_STATUSES, default: 'paged', index: true }) status: ConsultStatus;
  @Prop({ type: { id: String, name: String }, _id: false }) pagedTo?: { id: string; name: string };
  @Prop({ required: true, type: { id: String, name: String }, _id: false }) requestedBy: { id: string; name: string };
  @Prop({ required: true, type: Date }) requestedAt: Date;
  @Prop({ type: Date }) acceptedAt?: Date;
  @Prop({ type: Date }) seenAt?: Date;
  @Prop({ type: { at: Date, by: String, reason: String }, _id: false }) cancelled?: { at: Date; by: string; reason: string };
}

export const ConsultRequestSchema = SchemaFactory.createForClass(ConsultRequest);
