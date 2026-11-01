import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

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

  @Prop({ default: '' })
  lastVisit: string;

  @Prop({ required: true, index: true })
  followUpDate: string;

  @Prop({ default: '' })
  followUpTime: string;

  @Prop({ required: true })
  followUpType: string;

  @Prop({
    default: 'Scheduled',
    enum: ['Scheduled', 'Completed', 'Pending', 'Missed', 'Overdue'],
  })
  status: string;

  @Prop({ default: '' })
  assignedTo: string;

  @Prop({ default: '' })
  reminders: string;

  /** The doctor's note when the follow-up was ordered. */
  @Prop({ default: '' })
  note: string;

  /** The appointment the Scheduling Agent booked for this follow-up. */
  @Prop({ type: MongooseSchema.Types.ObjectId, index: true })
  appointmentId?: Types.ObjectId;
}

export const FollowUpItemSchema = SchemaFactory.createForClass(FollowUpItem);
