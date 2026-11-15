import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TimelineEventDocument = TimelineEvent & Document;

@Schema({ timestamps: true })
export class TimelineEvent {
  @Prop({ required: true, index: true })
  uhid: string;

  @Prop({ required: true })
  date: string;

  @Prop({ required: true })
  time: string;

  @Prop({
    required: true,
    enum: ['Consultation', 'Lab', 'Imaging', 'Prescription', 'Vitals', 'Emergency', 'Admission', 'Outpatient', 'Communication'],
  })
  category: string;

  @Prop({ required: true })
  title: string;

  @Prop({ default: '' })
  subtitle: string;

  @Prop({ default: '' })
  doctor: string;

  @Prop({ default: '' })
  department: string;

  @Prop({
    default: 'Completed',
    enum: ['Completed', 'In Progress', 'Scheduled', 'Reviewed'],
  })
  status: string;

  @Prop({ type: Object, default: {} })
  details: any;
}

export const TimelineEventSchema = SchemaFactory.createForClass(TimelineEvent);
