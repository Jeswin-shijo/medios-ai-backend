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

  @Prop({ default: '' })
  dueDateTime: string;

  @Prop({
    default: 'Pending',
    enum: ['Pending', 'Scheduled', 'In Progress', 'Completed'],
  })
  status: string;

  // Required: filing a task as Critical by default would flood the critical queue.
  @Prop({
    required: true,
    enum: ['Critical', 'Follow-up', 'Lab', 'Imaging', 'Medication', 'System'],
  })
  category: string;

  /** What the alert points at, e.g. `bed-request:<id>`. */
  @Prop()
  link?: string;

  /** Set on an escalation's alert: it is completed by Acknowledge, not by the toggle. */
  @Prop({
    type: {
      id: String,
      ladder: String,
      step: Number,
      titleKey: String,
      titleLabel: String,
      holderNames: { type: [String], default: [] },
    },
    _id: false,
  })
  escalation?: { id: string; ladder: string; step: number; titleKey: string; titleLabel: string; holderNames: string[] };
}

export const TaskAlertItemSchema = SchemaFactory.createForClass(TaskAlertItem);
// One alert per linked thing: lets an upsert on `link` run twice at once without a duplicate.
TaskAlertItemSchema.index({ link: 1 }, { unique: true, partialFilterExpression: { link: { $type: 'string' } } });
