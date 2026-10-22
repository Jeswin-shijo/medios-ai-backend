import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { displayDateTime } from '../../../common/utils/clinic-time';

export type VitalsRecordDocument = VitalsRecord & Document;

// Only BP and heart rate are mandatory; every other measurement is stored only
// when it was actually taken. BMI, BMI status and the overall status are derived
// by VitalsService from the values supplied.

@Schema({ timestamps: true })
export class VitalsRecord {
  @Prop({ required: true, index: true })
  uhid: string;

  @Prop({ default: () => displayDateTime() })
  recordedAt: string;

  @Prop({ default: '' })
  recordedBy: string;

  @Prop({ required: true })
  bpSystolic: number;

  @Prop({ required: true })
  bpDiastolic: number;

  @Prop({ required: true })
  heartRate: number;

  @Prop()
  temperature?: number;

  @Prop()
  spo2?: number;

  @Prop()
  respiratoryRate?: number;

  @Prop()
  bloodSugarFasting?: number;

  @Prop()
  bloodSugarPostPrandial?: number;

  @Prop()
  weightKg?: number;

  @Prop()
  heightCm?: number;

  @Prop()
  bmi?: number;

  @Prop({ enum: ['Normal', 'Overweight', 'Underweight', 'Obese'] })
  bmiStatus?: string;

  @Prop({ enum: ['Normal', 'Warning', 'Critical'] })
  status: string;

  @Prop({ default: '' })
  notes: string;
}

export const VitalsRecordSchema = SchemaFactory.createForClass(VitalsRecord);
