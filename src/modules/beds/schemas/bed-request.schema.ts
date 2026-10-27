import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { Need, PatientGender, RoomClass, WardType } from '../bed-types';

export type BedRequestDocument = BedRequest & Document;

export const REQUEST_TYPES = ['admission', 'transfer'] as const;
export const REQUEST_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type RequestPriority = (typeof REQUEST_PRIORITIES)[number];
export const REQUEST_STATES = ['searching', 'assigned', 'waiting', 'attention', 'cancelled'] as const;
export type RequestState = (typeof REQUEST_STATES)[number];
/** States in which the request is still being worked on. */
export const OPEN_STATES: RequestState[] = ['searching', 'waiting', 'attention'];

export type NeedEvidence = { need: Need; evidence: string };

/** A doctor's or admin's answer to a need found in the notes: who, when, and the words found. */
export type ResolvedNeed = NeedEvidence & { confirmed: boolean; byName: string; at: Date };

/** Why the agent (or staff) chose a bed, kept on the request. */
export type BedDecision = {
  suggestionId: string;
  by: 'ai' | 'rules' | 'staff';
  bedId: string;
  bedLabel: string;
  wardName: string;
  reason: string;
  appliedRules: string[];
  addedNeeds: NeedEvidence[];
  candidates: { bedId: string; label: string; score: number; reason: string }[];
  /** Notes needs a doctor or admin confirmed or dismissed before the bed was chosen. */
  resolvedNeeds: ResolvedNeed[];
  /** True when `by` is 'ai' and the answer came from sample mode (canned, no AI service). */
  sample: boolean;
  ruleOverride?: boolean;
};

/** A doctor's request for a bed, which the Bed Agent works through. */
@Schema({ timestamps: true })
export class BedRequest {
  @Prop({ type: String, enum: REQUEST_TYPES, required: true })
  type: 'admission' | 'transfer';

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Patient', required: true })
  patient: Types.ObjectId;

  @Prop({ required: true })
  patientName: string;

  @Prop({ required: true })
  patientUhid: string;

  @Prop({ required: true })
  patientAge: number;

  @Prop({ type: String, required: true })
  patientGender: PatientGender;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Bed' })
  fromBed?: Types.ObjectId;

  @Prop()
  fromBedLabel?: string;

  @Prop({ type: String })
  fromWardType?: WardType;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Admission' })
  admission?: Types.ObjectId;

  /** A transfer out of ICU or HDU into a lower ward. */
  @Prop({ default: false })
  stepDown: boolean;

  @Prop({ type: String, required: true })
  roomClass: RoomClass;

  @Prop({ type: [String], default: [] })
  needs: Need[];

  /** Needs the agent found in the notes and added by itself. */
  @Prop({ type: [{ _id: false, need: String, evidence: String }], default: [] })
  addedNeeds: NeedEvidence[];

  /** Needs found in the notes that a doctor must confirm. */
  @Prop({ type: [{ _id: false, need: String, evidence: String }], default: [] })
  pendingNeeds: NeedEvidence[];

  @Prop({ type: [String], default: [] })
  dismissedNeeds: Need[];

  /** Each confirm or dismiss of a notes need, with who and when. */
  @Prop({ type: [{ _id: false, need: String, evidence: String, confirmed: Boolean, byName: String, at: Date }], default: [] })
  resolvedNeeds: ResolvedNeed[];

  @Prop({ default: '' })
  notes: string;

  @Prop({ default: '' })
  department: string;

  @Prop({ default: '' })
  doctor: string;

  @Prop({ required: true })
  expectedStayDays: number;

  @Prop({ type: String, enum: REQUEST_PRIORITIES, required: true })
  priority: RequestPriority;

  /** 0 critical, 1 high, 2 medium, 3 low: sorts the waiting list. */
  @Prop({ required: true })
  priorityRank: number;

  @Prop({ type: String, enum: REQUEST_STATES, default: 'searching' })
  state: RequestState;

  @Prop({ default: '' })
  stateReason: string;

  @Prop({ required: true })
  stateSince: Date;

  /** True while searching, waiting or in attention. */
  @Prop({ default: true })
  open: boolean;

  @Prop({ default: 0 })
  attempts: number;

  /** While set and in the future, one agent pass holds this request. */
  @Prop()
  lockedUntil?: Date;

  @Prop({ required: true })
  requestedBy: string;

  @Prop({ required: true })
  requestedByName: string;

  @Prop({ required: true })
  requestedAt: Date;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Bed' })
  assignedBed?: Types.ObjectId;

  @Prop()
  assignedBedLabel?: string;

  @Prop()
  assignedAt?: Date;

  @Prop({ type: MongooseSchema.Types.Mixed })
  decision?: BedDecision;

  /** The alert in Tasks & Alerts raised while this request waits or needs attention. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'TaskAlertItem' })
  alert?: Types.ObjectId;

  @Prop()
  closedByName?: string;
}

export const BedRequestSchema = SchemaFactory.createForClass(BedRequest);
// One open request per patient: two doctors asking at once cannot both queue the patient.
BedRequestSchema.index({ patient: 1 }, { unique: true, partialFilterExpression: { open: { $eq: true } } });
BedRequestSchema.index({ state: 1, priorityRank: 1, requestedAt: 1 });
BedRequestSchema.index({ requestedAt: -1 });
