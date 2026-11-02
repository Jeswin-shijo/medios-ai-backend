import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { ActorRef, ActorRefSchema } from './actor-ref';

export type CorrectionDocument = Correction & Document;

export const CORRECTION_KINDS = ['change', 'reversal', 'discount', 'writeoff'] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];
export const CORRECTION_STATES = ['pending', 'approved', 'rejected'] as const;
export type CorrectionState = (typeof CORRECTION_STATES)[number];

@Schema({ timestamps: true })
export class Correction {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  bill: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId })
  line?: Types.ObjectId;

  @Prop({ type: String, required: true, enum: CORRECTION_KINDS })
  kind: CorrectionKind;

  @Prop({ type: Number })
  amount?: number;

  @Prop({ type: Number })
  qty?: number;

  @Prop({ type: Number })
  unitPrice?: number;

  @Prop({ type: Number })
  percent?: number;

  @Prop({ required: true })
  reason: string;

  @Prop({ type: ActorRefSchema, required: true })
  requestedBy: ActorRef;

  @Prop({ type: String, required: true, enum: CORRECTION_STATES, default: 'pending' })
  state: CorrectionState;

  @Prop({ type: MongooseSchema.Types.ObjectId })
  approvalId?: Types.ObjectId;

  @Prop({ type: Date })
  appliedAt?: Date;

  /** True when the agent proposed it (for example a reversal after a recollection). */
  @Prop({ default: false })
  suggested: boolean;
}

export const CorrectionSchema = SchemaFactory.createForClass(Correction);
