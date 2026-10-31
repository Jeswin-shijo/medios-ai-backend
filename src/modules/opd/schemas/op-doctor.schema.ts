import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type OpDoctorDocument = OpDoctor & Document;

/** One OP session: the weekdays it runs on (0 = Sunday ... 6 = Saturday) and its hours. */
@Schema({ _id: false })
export class OpSession {
  @Prop({ type: [Number], default: [] })
  days: number[];

  /** 'HH:mm' */
  @Prop({ required: true })
  start: string;

  /** 'HH:mm', after start */
  @Prop({ required: true })
  end: string;
}
export const OpSessionSchema = SchemaFactory.createForClass(OpSession);

/** A doctor who sees outpatients through the reception kiosk. */
@Schema({ timestamps: true })
export class OpDoctor {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ default: '' })
  qualifications: string;

  @Prop({ required: true, index: true })
  departmentCode: string;

  /** Consultation fee in whole rupees. */
  @Prop({ required: true, default: 0 })
  fee: number;

  /** Must be one of the queue rooms. */
  @Prop({ required: true })
  room: string;

  /** 1-3 characters of [A-Z0-9], unique among active doctors (checked in the service). */
  @Prop({ required: true })
  tokenPrefix: string;

  @Prop({ type: [OpSessionSchema], default: [] })
  sessions: OpSession[];

  @Prop({ default: 10 })
  avgConsultMinutes: number;

  @Prop({ default: true })
  active: boolean;

  /** The login account of this doctor, when there is one. */
  @Prop()
  userId?: string;
}

export const OpDoctorSchema = SchemaFactory.createForClass(OpDoctor);
// Database backstop for the service's check: two active doctors never share token letters.
OpDoctorSchema.index({ tokenPrefix: 1 }, { unique: true, partialFilterExpression: { active: true } });
