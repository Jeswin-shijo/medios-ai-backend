import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AppointmentDocument = Appointment & Document;

export const APPOINTMENT_CONFIRMATIONS = ['Unconfirmed', 'Confirmed', 'Reschedule Requested', 'Cancelled by Patient', 'Unreachable'];

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

  // Whether the patient has said they will come; set by the AI call agent or the front desk.
  @Prop({ default: 'Unconfirmed', enum: APPOINTMENT_CONFIRMATIONS })
  confirmation: string;

  @Prop()
  confirmedAt?: Date;

  /** How the slot was booked: '' (front desk) or 'AI call'. */
  @Prop({ default: '' })
  bookedVia: string;
}

export const AppointmentSchema = SchemaFactory.createForClass(Appointment);
