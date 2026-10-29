import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import type { ComplaintKey, PathwayKey, StepKey, TriageColour } from '../er-rules';

export type ErVisitDocument = ErVisit & Document;

export const ER_MODES = ['walk-in', 'ambulance', 'referred'] as const;
export type ErMode = (typeof ER_MODES)[number];

export const OPEN_ER_STATUSES = ['waiting-triage', 'waiting-doctor', 'in-treatment', 'waiting-bed'] as const;
export const ER_STATUSES = [...OPEN_ER_STATUSES, 'left'] as const;
export type ErStatus = (typeof ER_STATUSES)[number];

export const ER_DISPOSITIONS = ['admit', 'home', 'transfer', 'left-against-advice', 'died'] as const;
export type ErDispositionKind = (typeof ER_DISPOSITIONS)[number];

/** One colour decision. The list only ever grows. */
@Schema({ _id: false })
export class ErTriageEntry {
  @Prop({ required: true }) colour: string;
  @Prop({ required: true }) byName: string;
  @Prop({ required: true }) at: Date;
  @Prop() reason?: string;
  @Prop({ required: true, type: String, enum: ['triage', 'retriage'] }) kind: 'triage' | 'retriage';
}

/** `byName`, `at` and `changeReason` stay the first triage's; `colour` is the current one; `history` has every change. */
@Schema({ _id: false })
export class ErTriage {
  @Prop({ required: true }) suggested: string;
  @Prop({ type: [String], default: [] }) reasons: string[];
  @Prop({ required: true }) colour: string;
  @Prop({ required: true }) byName: string;
  @Prop({ required: true }) at: Date;
  @Prop() changeReason?: string;
  @Prop({ type: [ErTriageEntry], default: [] }) history: ErTriageEntry[];
}

/** The vital signs entered at triage. Kept on the visit even when no Vitals record is saved. */
@Schema({ _id: false })
export class ErVitals {
  @Prop() spo2?: number;
  @Prop() bpSystolic?: number;
  @Prop() bpDiastolic?: number;
  @Prop() heartRate?: number;
  @Prop() respiratoryRate?: number;
  @Prop() temperature?: number;
}

@Schema({ _id: false })
export class ErCancelled {
  @Prop({ required: true }) byName: string;
  @Prop({ required: true }) reason: string;
  @Prop({ required: true }) at: Date;
}

@Schema({ _id: false })
export class ErPathway {
  @Prop({ required: true }) key: string;
  @Prop({ required: true, type: String, enum: ['rules', 'staff'] }) startedBy: 'rules' | 'staff';
  /** Who started it, when `startedBy` is staff. */
  @Prop() startedByName?: string;
  @Prop({ type: ErCancelled }) cancelled?: ErCancelled;
}

@Schema({ _id: false })
export class ErStep {
  @Prop({ required: true }) key: string;
  @Prop() doneAt?: Date;
  @Prop() byName?: string;
}

@Schema({ _id: false })
export class ErDisposition {
  @Prop({ required: true, type: String, enum: ER_DISPOSITIONS }) kind: ErDispositionKind;
  @Prop({ required: true }) byName: string;
  @Prop({ required: true }) at: Date;
  @Prop({ default: '' }) notes: string;
}

/** One patient's stay in the emergency room. At most one open visit per patient. */
@Schema({ timestamps: true })
export class ErVisit {
  /** ER-0001, from the `er` counter. */
  @Prop({ required: true, unique: true }) number: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Patient', required: true }) patient: Types.ObjectId;
  @Prop({ required: true }) patientUhid: string;
  @Prop({ required: true }) patientName: string;
  @Prop({ required: true, type: String, enum: ER_MODES }) mode: ErMode;
  @Prop({ required: true, type: String }) complaint: ComplaintKey;
  @Prop({ default: '' }) complaintText: string;
  /** Clinic clock (staff-visible). */
  @Prop({ required: true }) arrivedAt: Date;
  @Prop({ type: ErTriage }) triage?: ErTriage;
  @Prop() vitalsId?: string;
  @Prop({ type: ErVitals }) vitals?: ErVitals;
  @Prop() painScore?: number;
  @Prop({ type: MongooseSchema.Types.ObjectId }) bay?: Types.ObjectId;
  /** The bay's name, kept here so the visit shows it without a lookup. An occupied bay cannot be renamed. */
  @Prop() bayName?: string;
  @Prop({ required: true, type: String, enum: ER_STATUSES, default: 'waiting-triage' }) status: ErStatus;
  @Prop({ type: [ErPathway], default: [] }) pathways: { key: PathwayKey; startedBy: 'rules' | 'staff'; startedByName?: string; cancelled?: ErCancelled }[];
  @Prop({ type: [ErStep], default: [] }) steps: { key: StepKey; doneAt?: Date; byName?: string }[];
  @Prop() doctorSeenAt?: Date;
  @Prop({ type: ErDisposition }) disposition?: ErDisposition;
  @Prop() leftAt?: Date;
  @Prop() leftReason?: string;
  /** Set once er.left reached the Coordinator; a left visit without it is announced again. */
  @Prop() leftAnnouncedAt?: Date;
  @Prop() handoverNote?: string;
  /** Set once er.arrived reached the Coordinator; a visit without it is announced again on the next arrival. */
  @Prop() announcedAt?: Date;
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Case', required: true }) case: Types.ObjectId;
}

export const ErVisitSchema = SchemaFactory.createForClass(ErVisit);
ErVisitSchema.index({ patient: 1 }, { unique: true, partialFilterExpression: { status: { $in: [...OPEN_ER_STATUSES] } } });
ErVisitSchema.index({ case: 1 });
