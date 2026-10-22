import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AppointmentDocument = Appointment & Document;

@Schema({ timestamps: true })
export class Appointment {
  @Prop({ required: true, index: true })
  uhid: string;

  @Prop({ required: true, index: true })
  patientName: string;

  @Prop({ required: true })
  age: number;

  @Prop({ required: true, enum: ['Male', 'Female', 'Other'] })
  gender: string;

  @Prop({ default: '' })
  avatar: string;

  @Prop({ default: '' })
  phone: string;

  @Prop({ required: true })
  time: string;

  @Prop({ required: true, index: true })
  date: string; // YYYY-MM-DD

  @Prop({ default: 'Consultation' })
  type: string;

  @Prop({ default: '' })
  condition: string;

  @Prop({
    default: 'Scheduled',
    enum: ['Checked In', 'Waiting', 'In Consultation', 'Scheduled', 'Completed', 'Canceled'],
  })
  status: string;

  @Prop({ default: '15 mins' })
  consultationDuration: string;

  @Prop({ default: '' })
  checkedInTime: string;

  @Prop({ default: '' })
  notes: string;

  @Prop({ type: [String], default: [] })
  tags: string[];
}

export const AppointmentSchema = SchemaFactory.createForClass(Appointment);
