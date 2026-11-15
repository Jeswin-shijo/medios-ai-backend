import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type SupportFeedbackDocument = SupportFeedback & Document;

/** A patient's rating, from a check-up call or taken at the desk. */
@Schema({ timestamps: true })
export class SupportFeedback {
  @Prop({ type: MongooseSchema.Types.ObjectId }) patient?: Types.ObjectId;
  @Prop() patientUhid?: string;
  @Prop() patientName?: string;
  @Prop({ type: MongooseSchema.Types.ObjectId }) case?: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId }) checkup?: Types.ObjectId;

  @Prop({ type: String, required: true, enum: ['call', 'desk'] }) source: 'call' | 'desk';
  /** 1 to 5. */
  @Prop({ required: true, min: 1, max: 5 }) overall: number;
  /** Optional 1 to 5 scores: communication, staff, waiting, facilities. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) aspects: Record<string, number>;
  @Prop({ maxlength: 500 }) comment?: string;
  @Prop({ required: true, default: false }) complaint: boolean;

  @Prop({ type: MongooseSchema.Types.ObjectId }) ticket?: Types.ObjectId;
  @Prop({ default: '' }) byName: string;
  @Prop({ type: Date, required: true }) at: Date;
}

export const SupportFeedbackSchema = SchemaFactory.createForClass(SupportFeedback);
SupportFeedbackSchema.index({ at: -1 });
