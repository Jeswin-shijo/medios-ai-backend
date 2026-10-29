import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, SchemaTypes } from 'mongoose';
import { displayDate, displayTime } from '../../../common/utils/clinic-time';

export type LabReportDocument = LabTestReport & Document;

@Schema()
export class LabParameter {
  @Prop({ required: true })
  name: string;

  // Numeric results stay numbers so trends and gauges can use them.
  @Prop({ type: SchemaTypes.Mixed, required: true })
  result: number | string;

  @Prop({ required: true })
  referenceRange: string;

  @Prop({ default: '' })
  unit: string;

  // A result is only "Normal" when the lab says so.
  @Prop({ required: true, enum: ['Normal', 'Low', 'High', 'Abnormal'] })
  status: string;

  @Prop()
  relativePosition?: number;

  /** Set by the Lab Agent: a critical value. */
  @Prop()
  critical?: boolean;
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
    required: true,
    enum: ['Blood', 'Urine', 'Biochemistry', 'Hematology', 'Others'],
  })
  category: string;

  @Prop({ default: () => displayDate() })
  date: string;

  @Prop({ default: () => displayTime() })
  time: string;

  @Prop({
    default: 'Pending',
    enum: ['Completed', 'Pending', 'Abnormal'],
  })
  status: string;

  @Prop({ type: [LabReportGroup], default: [] })
  groups: LabReportGroup[];

  @Prop({ type: LabAiSummary })
  aiSummary?: LabAiSummary;

  @Prop({ type: Object, default: null })
  trend: any;

  /** Set by the Lab Agent: the test line this report came from, and whether it was amended. */
  @Prop({ index: true })
  labLine?: string;

  @Prop()
  amended?: boolean;
}

export const LabTestReportSchema = SchemaFactory.createForClass(LabTestReport);
