import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { Need, RoomClass } from '../bed-types';

export type AdmissionDocument = Admission & Document;

export const ADMISSION_STATUSES = ['active', 'discharged'] as const;
export type AdmissionStatus = (typeof ADMISSION_STATUSES)[number];

/** One move between beds during an admission. */
@Schema({ _id: false })
export class BedTransfer {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Bed', required: true })
  fromBed: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Bed', required: true })
  toBed: Types.ObjectId;

  @Prop({ required: true })
  at: Date;

  /** The staff member's name. */
  @Prop({ required: true })
  by: string;

  @Prop()
  reason?: string;
}

export const BedTransferSchema = SchemaFactory.createForClass(BedTransfer);

/** A patient's inpatient stay, from admission to discharge. */
@Schema({ timestamps: true })
export class Admission {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Patient', required: true })
  patient: Types.ObjectId;

  @Prop({ required: true })
  patientUhid: string;

  @Prop({ required: true })
  patientName: string;

  /** The bed the patient is in now. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Bed', required: true })
  bed: Types.ObjectId;

  @Prop({ default: '' })
  doctor: string;

  @Prop({ default: '' })
  department: string;

  @Prop({ type: String, required: true })
  roomClass: RoomClass;

  @Prop({ type: [String], default: [] })
  needs: Need[];

  @Prop({ default: '' })
  notes: string;

  @Prop({ required: true })
  expectedStayDays: number;

  @Prop({ type: String, enum: ADMISSION_STATUSES, default: 'active' })
  status: AdmissionStatus;

  @Prop({ required: true })
  admittedAt: Date;

  /** The staff member's name. */
  @Prop({ required: true })
  admittedBy: string;

  @Prop()
  dischargedAt?: Date;

  @Prop()
  dischargedBy?: string;

  @Prop({ type: [BedTransferSchema], default: [] })
  transfers: BedTransfer[];

  /** The bed suggestion this admission was made from. */
  @Prop({ type: MongooseSchema.Types.ObjectId })
  suggestion?: Types.ObjectId;
}

export const AdmissionSchema = SchemaFactory.createForClass(Admission);
// One active admission per patient: two admits at once cannot give a patient two beds.
AdmissionSchema.index({ patient: 1 }, { unique: true, partialFilterExpression: { status: { $eq: 'active' } } });
