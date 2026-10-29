import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export type ChatLogDocument = ChatLog & Document;

/** One question put to the Ask box, what it was understood as, and exactly what (if anything) the AI was sent. */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class ChatLog {
  @Prop({ required: true }) user: string;
  @Prop({ required: true }) userName: string;
  @Prop({ type: String, default: '' }) question: string;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) intent: Record<string, unknown>;
  @Prop({ required: true }) answer: string;
  /** Exactly the { instructions, input } sent to the AI; null when the AI was not called. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null }) aiInput: Record<string, unknown> | null;
  @Prop({ default: false }) sample: boolean;
  createdAt?: Date;
}

export const ChatLogSchema = SchemaFactory.createForClass(ChatLog);
ChatLogSchema.index({ createdAt: -1 });
