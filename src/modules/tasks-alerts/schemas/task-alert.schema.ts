import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TaskAlertDocument = TaskAlertItem & Document;

@Schema({ timestamps: true })
export class TaskAlertItem {
  @Prop({ required: true })
  title: string;

  @Prop({ default: '' })
  subtitle: string;

  @Prop({ default: '' })
  patientName: string;

  @Prop({ default: '' })
  uhid: string;

  @Prop({
    required: true,
    enum: [
      'Lab Alert',
      'Follow-up',
      'Medication',
      'Imaging Alert',
      'Documentation',
      'Preventive Care',
      'Patient Communication',
      'Medication Alert',
      'System',
    ],
  })
  type: string;

  @Prop({ default: 'Medium', enum: ['High', 'Medium', 'Low'] })
  priority: string;

  @Prop({ default: 'Today' })
  dueDateTime: string;

  @Prop({
    default: 'Pending',
    enum: ['Pending', 'Scheduled', 'In Progress', 'Completed'],
  })
  status: string;

  @Prop({
    default: 'Critical',
    enum: ['Critical', 'Follow-up', 'Lab', 'Imaging', 'Medication', 'System'],
  })
  category: string;
}

export const TaskAlertItemSchema = SchemaFactory.createForClass(TaskAlertItem);
