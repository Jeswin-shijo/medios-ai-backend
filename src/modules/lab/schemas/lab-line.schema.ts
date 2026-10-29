import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type LabLineDocument = LabLine & Document;
export const LAB_LINE_STATUSES = ['ordered', 'collected', 'received', 'awaiting-validation', 'released', 'cancelled'] as const;
export type LabLineStatus = (typeof LAB_LINE_STATUSES)[number];

export interface LabResultRow {
  param: string;
  value: string | number;
  unit: string;
  flag: 'normal' | 'low' | 'high' | 'abnormal';
  critical: boolean;
}


/** One test on a request. */
@Schema({ timestamps: true })
export class LabLine {
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId, ref: 'LabRequest', index: true }) request: Types.ObjectId;
  @Prop({ required: true }) test: string;
  @Prop({ required: true, type: String, enum: LAB_LINE_STATUSES, default: 'ordered' }) status: LabLineStatus;
  /** Real time. */
  @Prop({ required: true, type: Date }) tatDueAt: Date;
  @Prop({ type: [Object], default: [] }) results: LabResultRow[];
  @Prop({ type: Object }) enteredBy?: { id: string; name: string };
  @Prop({ type: Date }) enteredAt?: Date;
  @Prop({ type: Object }) validatedBy?: { id: string; name: string };
  @Prop({ type: Date }) releasedAt?: Date;
  /** Real time of the FIRST release (version 1); every turnaround and on-time figure uses it, so an amendment never changes them. */
  @Prop({ type: Date }) releasedRealAt?: Date;
  /** Real time of the latest release, amendments included. */
  @Prop({ type: Date }) lastReleasedRealAt?: Date;
  @Prop({ default: 0 }) version: number;
  @Prop({ type: [Object], default: [] }) history: {
    version: number;
    results: LabResultRow[];
    enteredBy?: { id: string; name: string };
    enteredAt?: Date;
    validatedBy?: { id: string; name: string };
    releasedAt?: Date;
    amendReason?: string;
  }[];
  @Prop({ type: { by: String, reason: String, at: Date }, _id: false }) sentBack?: { by: string; reason: string; at: Date };
  @Prop({ type: { by: String, reason: String, at: Date }, _id: false }) cancelled?: { by: string; reason: string; at: Date };
  @Prop({ type: { active: Boolean, ackBy: String, ackById: String, ackAt: Date, ackNote: String }, _id: false }) critical?: {
    active: boolean;
    ackBy?: string;
    ackById?: string;
    ackAt?: Date;
    ackNote?: string;
  };
  /** Set while an amendment waits for a second person; carried into history on release. */
  @Prop() pendingAmendReason?: string;
  @Prop({ type: MongooseSchema.Types.ObjectId }) reportId?: Types.ObjectId;
}

export const LabLineSchema = SchemaFactory.createForClass(LabLine);
LabLineSchema.index({ releasedRealAt: 1 });
