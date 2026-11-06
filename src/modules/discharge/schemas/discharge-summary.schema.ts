import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { clinicNow } from '../../../common/utils/clinic-time';
import { ActorRef, ActorRefSchema } from '../../revenue/schemas/actor-ref';
import { DISCHARGE_KINDS, DischargeKind } from '../discharge-catalogue';

export type DischargeSummaryDocument = DischargeSummary & Document & { createdAt?: Date; updatedAt?: Date };

/**
 * Who wrote the "Course in hospital" paragraph: the AI; the AI in sample mode (canned, shown as SAMPLE); the rules
 * template, when the AI is off, slow or its answer refused (R13); or staff, by hand.
 */
export const COURSE_SOURCES = ['ai', 'ai-sample', 'rules', 'staff'] as const;
export type CourseSource = (typeof COURSE_SOURCES)[number];

/** The "Course in hospital" paragraph and who wrote it. */
@Schema({ _id: false })
export class SummaryCourse {
  @Prop({ default: '' }) text: string;
  @Prop({ type: String, required: true, enum: COURSE_SOURCES }) source: CourseSource;
}
export const SummaryCourseSchema = SchemaFactory.createForClass(SummaryCourse);

/** A signed version, kept when the doctor unlocks the summary to edit and re-sign. */
@Schema({ _id: false, minimize: false })
export class SummaryVersion {
  @Prop({ type: MongooseSchema.Types.Mixed, default: () => ({}) }) sections: Record<string, string>;
  @Prop({ type: SummaryCourseSchema, required: true }) course: SummaryCourse;
  @Prop({ type: ActorRefSchema, required: true }) signedBy: ActorRef;
  @Prop({ type: Date, required: true }) signedAt: Date;
  /** The Documents record of this version: archived (never deleted) when the version was unlocked. */
  @Prop() documentId?: string;
  @Prop({ type: ActorRefSchema }) unlockedBy?: ActorRef;
  /** Clinic clock. */
  @Prop({ type: Date }) unlockedAt?: Date;
}
export const SummaryVersionSchema = SchemaFactory.createForClass(SummaryVersion);

/**
 * The order's summary (discharge summary, transfer letter, against-advice note or death summary). R16: `minimize:
 * false` keeps an empty `sections` object as it is, and every write is an update of named paths, so nothing relies
 * on change tracking inside the Mixed `sections`.
 */
@Schema({ timestamps: true, minimize: false })
export class DischargeSummary {
  /** One summary per order. */
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, unique: true })
  order: Types.ObjectId;

  @Prop({ type: String, required: true, enum: DISCHARGE_KINDS })
  kind: DischargeKind;

  /** Section key (SUMMARY_SECTIONS, except `course`) to its text. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: () => ({}) })
  sections: Record<string, string>;

  @Prop({ type: SummaryCourseSchema, required: true })
  course: SummaryCourse;

  /**
   * The sections staff changed by hand. Drafting again from the record, while the summary has never been signed,
   * refreshes only the other sections, so it never overwrites an edit. An edited course shows as `source: 'staff'`.
   */
  @Prop({ type: [String], default: [] })
  edited: string[];

  /** Clinic clock: when the summary was first drafted. */
  @Prop({ type: Date, default: () => clinicNow() })
  draftedAt: Date;

  @Prop({ type: ActorRefSchema })
  signedBy?: ActorRef;

  /** Clinic clock. Set while signed; the summary is locked then. */
  @Prop({ type: Date })
  signedAt?: Date;

  @Prop({ type: [SummaryVersionSchema], default: [] })
  versions: SummaryVersion[];

  /** The Documents record of the current signed version. */
  @Prop()
  documentId?: string;

  /**
   * Clinic clock (R35): the order was cancelled after this summary was signed, so its document is archived and the
   * summary is kept for history only, never current again. Its signature and document id stay as they were.
   */
  @Prop({ type: Date })
  archivedAt?: Date;
}

export const DischargeSummarySchema = SchemaFactory.createForClass(DischargeSummary);
