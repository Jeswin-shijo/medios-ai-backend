import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import type { TubeKey } from '../lab-catalogue';

export type LabSampleDocument = LabSample & Document;
export const LAB_SAMPLE_STATUSES = ['waiting', 'collected', 'received', 'rejected', 'cancelled'] as const;
export type LabSampleStatus = (typeof LAB_SAMPLE_STATUSES)[number];

/** One tube (or container) for a request: the tests that share it. */
@Schema({ timestamps: true })
export class LabSample {
  @Prop({ required: true, unique: true }) number: string;
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId, ref: 'LabRequest', index: true }) request: Types.ObjectId;
  @Prop({ required: true, type: String }) tube: TubeKey;
  @Prop({ type: [MongooseSchema.Types.ObjectId], default: [] }) lines: Types.ObjectId[];
  @Prop({ required: true, type: String, enum: LAB_SAMPLE_STATUSES, default: 'waiting' }) status: LabSampleStatus;
  /** Real time. */
  @Prop({ required: true, type: Date }) collectBy: Date;
  @Prop({ type: { by: String, at: Date }, _id: false }) collected?: { by: string; at: Date };
  /** Real time of the collection: the on-time figures compare real times only. */
  @Prop({ type: Date }) collectedRealAt?: Date;
  @Prop({ type: { by: String, at: Date }, _id: false }) received?: { by: string; at: Date };
  @Prop({ type: { by: String, reason: String, note: String, at: Date }, _id: false }) rejected?: { by: string; reason: string; note: string; at: Date };
  @Prop({ type: MongooseSchema.Types.ObjectId }) replaces?: Types.ObjectId;
}

export const LabSampleSchema = SchemaFactory.createForClass(LabSample);
LabSampleSchema.index({ collectedRealAt: 1 });
