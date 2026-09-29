import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type FollowUpDocument = FollowUpItem & Document;

@Schema({ timestamps: true })
export class FollowUpItem {
  @Prop({ required: true, index: true })
  uhid: string;

  @Prop({ required: true })
  patientName: string;

  @Prop({ required: true })
  age: number;

  @Prop({ required: true, enum: ['Male', 'Female', 'Other'] })
  gender: string;

  @Prop({ default: '' })
  avatar: string;

  @Prop({ default: '26 Sep 2026' })
  lastVisit: string;

  @Prop({ required: true, index: true })
  followUpDate: string;

  @Prop({ default: '10:00 AM' })
  followUpTime: string;

  @Prop({ default: 'Diabetes & BP Review' })
  followUpType: string;

  @Prop({
    default: 'Scheduled',
    enum: ['Scheduled', 'Completed', 'Pending', 'Missed', 'Overdue'],
  })
  status: string;

  @Prop({ default: 'Dr. Shajin' })
  assignedTo: string;

  @Prop({ default: 'SMS + WhatsApp (24h before)' })
  reminders: string;
}

export const FollowUpItemSchema = SchemaFactory.createForClass(FollowUpItem);
