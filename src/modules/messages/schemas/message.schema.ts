import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type MessageThreadDocument = MessageThread & Document;

@Schema({ _id: false })
export class ChatAttachment {
  @Prop({ default: 'pdf', enum: ['image', 'pdf'] })
  type: string;

  @Prop({ default: '' })
  name: string;

  @Prop({ default: '' })
  size: string;
}

@Schema({ _id: false })
export class ChatMessage {
  @Prop({ required: true, enum: ['doctor', 'patient', 'system', 'staff'] })
  sender: string;

  @Prop({ required: true })
  text: string;

  @Prop({ default: '10:00 AM' })
  time: string;

  @Prop({ default: 'delivered', enum: ['sent', 'delivered', 'read'] })
  status: string;

  @Prop({ type: ChatAttachment, default: null })
  attachment: ChatAttachment;
}

@Schema({ timestamps: true })
export class MessageThread {
  @Prop({ required: true })
  contactName: string;

  @Prop({ default: '' })
  uhid: string;

  @Prop({ default: 0 })
  age: number;

  @Prop({ default: 'Male' })
  gender: string;

  @Prop({
    required: true,
    enum: ['Patient', 'Lab', 'Pharmacy', 'Imaging', 'Nursing', 'Department', 'Admin'],
  })
  category: string;

  @Prop({ default: '' })
  preview: string;

  @Prop({ default: 'Just now' })
  time: string;

  @Prop({ default: 0 })
  unreadCount: number;

  @Prop({ default: true })
  online: boolean;

  @Prop({ default: '' })
  condition: string;

  @Prop({ type: [ChatMessage], default: [] })
  messages: ChatMessage[];
}

export const MessageThreadSchema = SchemaFactory.createForClass(MessageThread);
