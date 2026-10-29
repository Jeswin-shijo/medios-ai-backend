import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type EscalationDocument = Escalation & Document;

export type EscalationSource = { kind: 'clock' | 'failed' | 'loop' | 'manual'; id?: string };

/** Something late or broken, walking up a ladder of duty titles until a person acknowledges it. Real time. */
@Schema({ timestamps: true })
export class Escalation {
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null }) case?: Types.ObjectId | null;
  @Prop({ required: true }) ladder: string;
  @Prop({ required: true, default: 0 }) step: number;
  @Prop({ required: true }) reason: string;
  @Prop({ required: true, type: { kind: { type: String, enum: ['clock', 'failed', 'loop', 'manual'], required: true }, id: { type: String } }, _id: false })
  source: EscalationSource;
  @Prop({ type: String, default: 'open', enum: ['open', 'acknowledged'] }) state: 'open' | 'acknowledged';
  @Prop({ type: MongooseSchema.Types.ObjectId }) alert: Types.ObjectId;
  @Prop({ required: true, type: Date }) raisedAt: Date;
  @Prop({ required: true, type: Date }) stepAt: Date;
  @Prop() ackBy?: string;
  @Prop() ackByName?: string;
  @Prop({ type: Date }) ackAt?: Date;
}

export const EscalationSchema = SchemaFactory.createForClass(Escalation);
EscalationSchema.index({ state: 1, stepAt: 1 });
// One escalation per source (a clock, say), so raising twice for it cannot double up.
EscalationSchema.index({ 'source.kind': 1, 'source.id': 1 }, { unique: true, partialFilterExpression: { 'source.id': { $exists: true } } });
