import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { BedAiInput, BedAiOutput } from '../bed-ai-task';
import { Need, RoomClass } from '../bed-types';

export type BedSuggestionDocument = BedSuggestion & Document;

/** pending → ok | timeout | invalid | provider_error after refine; off when the AI was not asked. */
export const SUGGESTION_AI_STATUSES = ['pending', 'off', 'ok', 'timeout', 'invalid', 'provider_error'] as const;
export type SuggestionAiStatus = (typeof SUGGESTION_AI_STATUSES)[number];

/** The admission request as staff entered it. Internal: the notes are not de-identified. */
@Schema({ _id: false })
export class SuggestionRequest {
  @Prop({ type: String, required: true })
  roomClass: RoomClass;

  @Prop({ type: [String], default: [] })
  needs: Need[];

  @Prop({ default: '' })
  department: string;

  @Prop({ default: '' })
  doctor: string;

  @Prop({ required: true })
  expectedStayDays: number;

  @Prop({ default: '' })
  notes: string;

  /** Set for a transfer: the bed the patient is in now. */
  @Prop()
  currentBedId?: string;
}

export const SuggestionRequestSchema = SchemaFactory.createForClass(SuggestionRequest);

/** One bed in the rule-based order. */
@Schema({ _id: false })
export class RuleRankingEntry {
  @Prop({ required: true })
  bedId: string;

  @Prop({ required: true })
  score: number;

  /** The reason fragments, which the AI is shown. */
  @Prop({ type: [String], default: [] })
  reasons: string[];

  @Prop({ required: true })
  reason: string;

  @Prop({ default: false })
  stepUp: boolean;
}

export const RuleRankingEntrySchema = SchemaFactory.createForClass(RuleRankingEntry);

/** What the AI answered, or why it gave no answer. */
@Schema({ _id: false })
export class SuggestionAiResult {
  @Prop({ type: String, enum: SUGGESTION_AI_STATUSES, required: true })
  status: SuggestionAiStatus;

  @Prop()
  sample?: boolean;

  @Prop()
  provider?: string;

  @Prop()
  model?: string;

  @Prop()
  latencyMs?: number;

  /** The validated answer, when status is ok. */
  @Prop({ type: Object })
  output?: BedAiOutput;

  @Prop()
  detail?: string;
}

export const SuggestionAiResultSchema = SchemaFactory.createForClass(SuggestionAiResult);

/** One bed suggestion: its inputs, the rule and AI results, and the bed finally chosen. */
@Schema({ timestamps: true })
export class BedSuggestion {
  /** The staff member's user id. */
  @Prop({ required: true })
  createdBy: string;

  @Prop({ required: true })
  createdByName: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Patient', required: true })
  patient: Types.ObjectId;

  @Prop({ type: SuggestionRequestSchema, required: true })
  request: SuggestionRequest;

  /** De-identified: exactly what is sent to the AI. */
  @Prop({ type: Object, required: true })
  aiInput: BedAiInput;

  /** The AI's opaque bed refs ("b1") → bed ids. */
  @Prop({ type: Object, default: {} })
  refs: Record<string, string>;

  /** Every bed that passes the rules; choosing another needs a rule override. */
  @Prop({ type: [String], default: [] })
  eligibleBedIds: string[];

  @Prop({ type: [RuleRankingEntrySchema], default: [] })
  ruleRanking: RuleRankingEntry[];

  @Prop({ type: [String], default: [] })
  appliedRules: string[];

  @Prop({ type: [String], default: [] })
  blockedBy: string[];

  @Prop()
  classNote?: string;

  @Prop({ type: SuggestionAiResultSchema, required: true })
  ai: SuggestionAiResult;

  /** The top suggestion after the AI's reordering. */
  @Prop()
  finalTopBedId?: string;

  @Prop()
  finalBedId?: string;

  @Prop()
  wasTopPick?: boolean;

  /** Why staff chose another bed than the top suggestion, or ignored the rules. */
  @Prop()
  reason?: string;

  @Prop()
  ruleOverride?: boolean;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Admission' })
  admission?: Types.ObjectId;
}

export const BedSuggestionSchema = SchemaFactory.createForClass(BedSuggestion);
