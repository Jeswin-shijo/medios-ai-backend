import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type WaitItemDocument = WaitItem & Document & { createdAt?: Date; updatedAt?: Date };
export const WAIT_REASONS = ['doctor-leave', 'bumped', 'patient-request', 'earlier-wanted', 'no-slot'] as const;
export type WaitReason = (typeof WAIT_REASONS)[number];

/** A patient or procedure waiting for a person to pick a new time (the waitlist). */
@Schema({ timestamps: true })
export class WaitItem {
  @Prop({ required: true, type: String, enum: ['appointment', 'procedure'] }) kind: 'appointment' | 'procedure';
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId }) refId: Types.ObjectId;
  @Prop({ required: true, type: String, enum: WAIT_REASONS }) reason: WaitReason;
  @Prop({ required: true, type: String, enum: ['stat', 'urgent', 'routine'] }) priority: 'stat' | 'urgent' | 'routine';
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId, ref: 'Patient' }) patient: Types.ObjectId;
  @Prop({ required: true }) patientUhid: string;
  @Prop({ required: true }) patientName: string;
  @Prop() doctorId?: string;
  /** { date, time } for an appointment, { start } for a procedure. */
  @Prop({ required: true, type: MongooseSchema.Types.Mixed }) original: { date: string; time: string } | { start: Date };
  /** { date, time } for an appointment, { start, room } for a procedure. */
  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] }) offered: ({ date: string; time: string } | { start: Date; room: string })[];
  @Prop({ default: false }) wantsEarlier: boolean;
  @Prop({ required: true, type: String, enum: ['open', 'resolved', 'cancelled'], default: 'open', index: true }) status: 'open' | 'resolved' | 'cancelled';
  @Prop({ required: true, type: Date, default: () => new Date() }) createdAt: Date;
  @Prop({ type: Date }) resolvedAt?: Date;
}

export const WaitItemSchema = SchemaFactory.createForClass(WaitItem);
WaitItemSchema.index({ kind: 1, refId: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });
