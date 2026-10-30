import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import type { Flag } from '../pharmacy-rules';

export type PharmacyLineDocument = PharmacyLine & Document & { createdAt?: Date; updatedAt?: Date };
export const LINE_STATUSES = ['to-check', 'query', 'approved', 'issued', 'stopped', 'rejected', 'cancelled'] as const;
export type PharmacyLineStatus = (typeof LINE_STATUSES)[number];
export const QUERY_KINDS = ['allergy', 'clash', 'dose', 'kidney', 'stock', 'other'] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];

type By = { id: string; name: string };

/** What an answered Change or Switch of an issued line will add, stored with the answer so a crash never loses it. */
export interface ReplacementSpec {
  id: string;
  medicine: string | null;
  product: string | null;
  dose: number | null;
  unit: string;
  route: string;
  frequency: string;
  durationDays: number | null;
  quantity: number | null;
  note?: string;
  confirm?: { by: By; reason: string };
}

export interface LineQuery {
  seq: number;
  kind: QueryKind;
  question: string;
  by: By;
  /** Clinic clock. */
  at: Date;
  /** Real time. */
  openedRealAt: Date;
  dueAt: Date;
  suggestions: string[];
  /** Keys of the unconfirmed red flags on the line when the query opened: the most a Keep answer can confirm. */
  redKeys?: string[];
  answer?: { outcome: string; by: By; reason: string; at: Date; realAt: Date; replacement?: ReplacementSpec };
}

export interface LineHistoryEntry {
  version: number;
  product: string | null;
  dose: number | null;
  unit: string;
  route: string;
  frequency: string;
  durationDays: number | null;
  quantity: number | null;
  flags: Flag[];
  by: By;
  at: Date;
}

/** One medicine on an order. Times marked real are for clocks; the rest are the clinic clock. */
@Schema({ timestamps: true })
export class PharmacyLine {
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId, ref: 'PharmacyOrder', index: true }) order: Types.ObjectId;
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId, index: true }) patient: Types.ObjectId;

  // What was ordered.
  /** Medicine key; null means unlisted. */
  @Prop({ type: String, default: null }) medicine: string | null;
  @Prop({ type: String, default: null }) product: string | null;
  /** The typed name of an unlisted medicine. */
  @Prop() freeName?: string;
  @Prop({ type: Number, default: null }) dose: number | null;
  /** A prescription's dose text when it could not be read. */
  @Prop() doseText?: string;
  @Prop({ default: '' }) unit: string;
  @Prop({ default: '' }) route: string;
  @Prop({ default: 'OD' }) frequency: string;
  @Prop({ type: Number, default: null }) durationDays: number | null;
  /** In the product's issue unit; null when unknown. */
  @Prop({ type: Number, default: null }) quantity: number | null;
  @Prop({ default: '' }) note: string;
  @Prop({ default: 1 }) version: number;

  // Status and its times (real time).
  @Prop({ required: true, type: String, enum: LINE_STATUSES, default: 'to-check', index: true }) status: PharmacyLineStatus;
  @Prop({ type: Date }) enteredCheckAt?: Date;
  @Prop({ type: Date }) checkedAt?: Date;
  @Prop({ type: Date }) issueFrom?: Date;
  @Prop({ default: false }) waitingForStock: boolean;

  // Links.
  @Prop({ type: MongooseSchema.Types.ObjectId }) replaces?: Types.ObjectId;
  @Prop() prescriptionItem?: string;
  @Prop() prescriptionRev?: number;

  @Prop({ type: [Object], default: [] }) flags: Flag[];

  @Prop({ default: 0 }) querySeq: number;
  @Prop({ type: Object }) query?: LineQuery;

  // Outcomes.
  @Prop({ type: Object }) approved?: { by: By; at: Date; reason?: string; version?: number };
  @Prop({ type: Object }) rejected?: { by: By; reason: string; at: Date };
  @Prop({ type: Object }) issuing?: { by: By; store: string; realAt: Date };
  @Prop({ type: Object }) issued?: {
    by: By;
    at: Date;
    realAt: Date;
    store: string;
    batches: { batch: string; batchNo: string; expiry: string; qty: number }[];
    announcedAt?: Date;
  };
  @Prop({ type: Object }) cancelled?: { by: By; reason: string; at: Date };
  @Prop({ type: Object }) stopped?: { by: By; reason: string; at: Date };

  @Prop({ type: [Object], default: [] }) history: LineHistoryEntry[];
}

export const PharmacyLineSchema = SchemaFactory.createForClass(PharmacyLine);
PharmacyLineSchema.index({ patient: 1, status: 1 });
PharmacyLineSchema.index({ status: 1, enteredCheckAt: 1 });
