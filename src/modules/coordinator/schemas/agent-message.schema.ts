import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { PRIORITIES } from '../coordinator-types';
import type { AgentKey, Priority } from '../coordinator-types';

export type MessageDocument = AgentMessage & Document;

export const MESSAGE_STATES = ['pending', 'delivered', 'failed'] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

/** One message between agents, stored before it is delivered. */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class AgentMessage {
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  case: Types.ObjectId | null;

  @Prop({ required: true, type: String }) from: AgentKey;
  @Prop({ type: [String], default: [] }) to: AgentKey[];
  @Prop({ required: true }) type: string;
  @Prop({ required: true, type: String, enum: PRIORITIES }) priority: Priority;
  @Prop({ required: true }) summary: string;
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) payload: Record<string, unknown>;
  @Prop({ type: Date, default: null }) dueBy: Date | null;
  @Prop({ default: false }) needsPerson: boolean;
  @Prop({ default: false }) opensWork: boolean;
  @Prop({ type: MongooseSchema.Types.ObjectId }) resolves?: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId }) causedBy?: Types.ObjectId;
  @Prop({ default: 0 }) hop: number;
  @Prop({ required: true }) dedupeKey: string;
  @Prop({ type: String, default: 'pending', enum: MESSAGE_STATES }) state: MessageState;
  @Prop({ default: 0 }) attempts: number;
  @Prop() resolvedAt?: Date;
  @Prop({ type: MongooseSchema.Types.ObjectId }) resolvedBy?: Types.ObjectId;
  @Prop() lockedUntil?: Date;
  createdAt: Date;
}

export const AgentMessageSchema = SchemaFactory.createForClass(AgentMessage);
AgentMessageSchema.index({ case: 1, createdAt: -1 });
AgentMessageSchema.index({ state: 1 });
AgentMessageSchema.index({ dedupeKey: 1, createdAt: -1 });
// The log (newest first), a bed request's own messages, and the open-work queue.
AgentMessageSchema.index({ createdAt: -1 });
AgentMessageSchema.index({ 'payload.requestId': 1, createdAt: -1 }, { partialFilterExpression: { 'payload.requestId': { $exists: true } } });
AgentMessageSchema.index({ opensWork: 1, resolvedAt: 1, createdAt: -1 }, { partialFilterExpression: { opensWork: true } });
