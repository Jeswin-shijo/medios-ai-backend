import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { displayTime } from '../../../common/utils/clinic-time';

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

@Schema()
export class ChatMessage {
  @Prop({ required: true, enum: ['doctor', 'patient', 'system', 'staff'] })
  sender: string;

  // Empty when the message is only an attachment.
  @Prop({ default: '' })
  text: string;

  @Prop({ default: () => displayTime() })
  time: string;

  @Prop({ default: 'sent', enum: ['sent', 'delivered', 'read'] })
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

  @Prop()
  age?: number;

  @Prop({ default: '' })
  gender: string;

  @Prop({
    required: true,
    enum: ['Patient', 'Lab', 'Pharmacy', 'Imaging', 'Nursing', 'Department', 'Admin'],
  })
  category: string;

  @Prop({ default: '' })
  preview: string;

  @Prop({ default: () => displayTime() })
  time: string;

  @Prop({ default: 0 })
  unreadCount: number;

  @Prop({ default: false })
  online: boolean;

  @Prop({ default: '' })
  condition: string;

  @Prop({ type: [ChatMessage], default: [] })
  messages: ChatMessage[];
}

export const MessageThreadSchema = SchemaFactory.createForClass(MessageThread);
