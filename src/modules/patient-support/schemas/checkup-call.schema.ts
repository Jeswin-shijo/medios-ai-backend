import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { CARE_GROUPS, CHECKUP_RESULTS, CHECKUP_STATES } from '../support-catalogue';

export type CheckupCallDocument = CheckupCall & Document;

/** The day-2 check-up call after a patient goes home. */
@Schema({ timestamps: true })
export class CheckupCall {
  /** CU-0001. */
  @Prop({ required: true, unique: true }) number: string;
  /** Once per source: `discharge:<planId>`. */
  @Prop({ required: true, unique: true }) sourceKey: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true }) patient: Types.ObjectId;
  @Prop({ required: true }) patientUhid: string;
  @Prop({ required: true }) patientName: string;
  @Prop({ type: MongooseSchema.Types.ObjectId }) case?: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId }) plan?: Types.ObjectId;

  /** `home` or `against-advice`. */
  @Prop({ required: true }) kind: string;
  /** Clinic clock. */
  @Prop({ type: Date, required: true }) leftAt: Date;
  /** YYYY-MM-DD, clinic clock. */
  @Prop({ required: true }) dueDay: string;
  @Prop({ required: true, enum: CARE_GROUPS }) group: string;

  @Prop({ required: true, enum: CHECKUP_STATES, default: 'scheduled' }) state: string;
  @Prop({ enum: CHECKUP_RESULTS }) result?: string;
  @Prop({ required: true, default: 0 }) tries: number;
  @Prop({ type: Date }) nextTryAt?: Date;
  @Prop() skipReason?: string;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) answers: Record<string, string>;
  @Prop() questionText?: string;
  /** Keys of the worrying answers. */
  @Prop({ type: [String], default: [] }) worrying: string[];
  /** Keys of the emergency answers. */
  @Prop({ type: [String], default: [] }) emergency: string[];

  @Prop() rating?: number;
  @Prop() comment?: string;
  @Prop() byName?: string;
  @Prop({ type: Date }) at?: Date;

  @Prop({ type: MongooseSchema.Types.ObjectId }) agentCall?: Types.ObjectId;
  @Prop() providerCallId?: string;

  @Prop({ type: Date }) reviewedAt?: Date;
  @Prop() reviewedByName?: string;
  @Prop() reviewNote?: string;

  @Prop({ type: [String], default: [] }) announced: string[];
}

export const CheckupCallSchema = SchemaFactory.createForClass(CheckupCall);
CheckupCallSchema.index({ state: 1, dueDay: 1 });
