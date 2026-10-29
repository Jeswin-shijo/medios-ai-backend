import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import type { AgentKey, Priority } from '../coordinator-types';

export type CaseDocument = Case & Document;

export const CASE_KINDS = ['er', 'ipd'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];
export const CASE_STATES = ['open', 'closed'] as const;
export type CaseState = (typeof CASE_STATES)[number];

/** One patient's journey through the hospital agents. Times are on the clinic clock. */
@Schema({ timestamps: true })
export class Case {
  @Prop({ required: true, unique: true }) number: string;
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId }) patient: Types.ObjectId;
  @Prop({ required: true }) patientUhid: string;
  @Prop({ required: true }) patientName: string;
  @Prop({ required: true, type: String, enum: CASE_KINDS }) kind: CaseKind;
  @Prop({ required: true, type: String, enum: ['critical', 'high', 'medium', 'low'] }) priority: Priority;
  @Prop({ type: String, default: 'open', enum: CASE_STATES }) state: CaseState;
  @Prop({ required: true, type: Date }) openedAt: Date;
  @Prop({ type: Date }) closedAt?: Date;
  @Prop() closedReason?: string;
  @Prop({ type: [String], default: [] }) agents: AgentKey[];
  @Prop({
    type: { bedRequestIds: { type: [String], default: [] }, admissionId: { type: String } },
    default: () => ({ bedRequestIds: [] }),
    _id: false,
  })
  refs: { bedRequestIds: string[]; admissionId?: string };
  @Prop({ required: true, type: String }) openedBy: AgentKey;
}

export const CaseSchema = SchemaFactory.createForClass(Case);
// One open case per patient; closed cases are kept.
CaseSchema.index({ patient: 1 }, { unique: true, partialFilterExpression: { state: { $eq: 'open' } } });
CaseSchema.index({ openedAt: -1 });
