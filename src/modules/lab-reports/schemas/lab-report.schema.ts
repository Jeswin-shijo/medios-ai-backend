import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LabReportDocument = LabTestReport & Document;

@Schema({ _id: false })
export class LabParameter {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  result: string;

  @Prop({ required: true })
  referenceRange: string;

  @Prop({ default: '' })
  unit: string;

  @Prop({ default: 'Normal', enum: ['Normal', 'Low', 'High', 'Abnormal'] })
  status: string;

  @Prop({ default: 50 })
  relativePosition: number;
}

@Schema({ _id: false })
export class LabReportGroup {
  @Prop({ required: true })
  category: string;

  @Prop({ type: [LabParameter], default: [] })
  parameters: LabParameter[];
}

@Schema({ _id: false })
export class LabAiSummary {
  @Prop({ type: [String], default: [] })
  findings: string[];

  @Prop({ default: '' })
  interpretation: string;

  @Prop({ type: [String], default: [] })
  recommendations: string[];
}

@Schema({ timestamps: true })
export class LabTestReport {
  @Prop({ required: true, index: true })
  uhid: string;

  @Prop({ required: true })
  testName: string;

  @Prop({
    default: 'Blood',
    enum: ['Blood', 'Urine', 'Biochemistry', 'Hematology', 'Others'],
  })
  category: string;

  @Prop({ default: '26 Sep 2026' })
  date: string;

  @Prop({ default: '08:30 AM' })
  time: string;

  @Prop({
    default: 'Completed',
    enum: ['Completed', 'Pending', 'Abnormal'],
  })
  status: string;

  @Prop({ type: [LabReportGroup], default: [] })
  groups: LabReportGroup[];

  @Prop({ type: LabAiSummary, default: () => ({}) })
  aiSummary: LabAiSummary;

  @Prop({ type: Object, default: null })
  trend: any;
}

export const LabTestReportSchema = SchemaFactory.createForClass(LabTestReport);
