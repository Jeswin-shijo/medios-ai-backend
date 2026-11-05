import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { ActorRef, ActorRefSchema } from '../../revenue/schemas/actor-ref';
import { DISCHARGE_KINDS, DischargeKind } from '../discharge-catalogue';

export type DischargeSummaryDocument = DischargeSummary & Document;

export const COURSE_SOURCES = ['ai', 'ai-sample', 'staff'] as const;
export type CourseSource = (typeof COURSE_SOURCES)[number];

/** The "Course in hospital" paragraph and who wrote it. */
@Schema({ _id: false })
export class SummaryCourse {
  @Prop({ default: '' }) text: string;
  @Prop({ type: String, required: true, enum: COURSE_SOURCES }) source: CourseSource;
}
export const SummaryCourseSchema = SchemaFactory.createForClass(SummaryCourse);

/** A signed version, kept when the doctor unlocks the summary to edit and re-sign. */
@Schema({ _id: false })
export class SummaryVersion {
  @Prop({ type: MongooseSchema.Types.Mixed, default: () => ({}) }) sections: Record<string, string>;
  @Prop({ type: SummaryCourseSchema, required: true }) course: SummaryCourse;
  @Prop({ type: ActorRefSchema, required: true }) signedBy: ActorRef;
  @Prop({ type: Date, required: true }) signedAt: Date;
}
export const SummaryVersionSchema = SchemaFactory.createForClass(SummaryVersion);

/** The order's summary (discharge summary, transfer letter, against-advice note or death summary). */
@Schema({ timestamps: true })
export class DischargeSummary {
  /** One summary per order. */
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, unique: true })
  order: Types.ObjectId;

  @Prop({ type: String, required: true, enum: DISCHARGE_KINDS })
  kind: DischargeKind;

  /** Section key (SUMMARY_SECTIONS) to its text. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: () => ({}) })
  sections: Record<string, string>;

  @Prop({ type: SummaryCourseSchema, required: true })
  course: SummaryCourse;

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
}

export const DischargeSummarySchema = SchemaFactory.createForClass(DischargeSummary);
