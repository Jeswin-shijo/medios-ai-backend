import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type PharmacyOrderDocument = PharmacyOrder & Document & { createdAt?: Date; updatedAt?: Date };
export const PHARMACY_PRIORITIES = ['stat', 'urgent', 'routine'] as const;
export type PharmacySetting = 'ER' | 'Ward' | 'OPD';

/** One doctor's order of medicines (or one prescription) for a patient, at one priority. */
@Schema({ timestamps: true })
export class PharmacyOrder {
  @Prop({ required: true, unique: true }) number: string;
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId, ref: 'Patient', index: true }) patient: Types.ObjectId;
  @Prop({ required: true }) patientUhid: string;
  @Prop({ required: true }) patientName: string;
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId, index: true }) case: Types.ObjectId;
  @Prop({ required: true, type: String, enum: ['ER', 'Ward', 'OPD'] }) setting: PharmacySetting;
  @Prop() ward?: string;
  @Prop({ required: true, type: { id: String, name: String }, _id: false }) orderedBy: { id: string; name: string };
  @Prop({ required: true, type: String, enum: PHARMACY_PRIORITIES }) priority: 'stat' | 'urgent' | 'routine';
  @Prop({ default: '' }) note: string;
  @Prop({ required: true, type: String, enum: ['order', 'prescription'], default: 'order' }) source: 'order' | 'prescription';
  /** The prescription this order mirrors; unique when set. */
  @Prop({ type: MongooseSchema.Types.ObjectId }) prescription?: Types.ObjectId;
  @Prop({ default: 0 }) prescriptionRev: number;
  /** Real time: a prescription sync in progress holds this until it ends. */
  @Prop({ type: Date }) syncingUntil?: Date;
  /** The medicines a patient leaves with, placed by the Discharge Agent (always a Ward order). */
  @Prop({ default: false }) takeHome: boolean;
  /** Clinic clock: when the patient is planned to leave (take-home orders only). */
  @Prop({ type: Date }) plannedLeaveAt?: Date;
  /** Clinic clock. */
  @Prop({ required: true, type: Date }) orderedAt: Date;
  /** Real time: set after pharmacy.ordered went out. */
  @Prop({ type: Date }) announcedAt?: Date;
  /** Clock rounds (real time). A round's clock ref is `<orderId>:c<checkRound>` / `<orderId>:i<issueRound>`. */
  @Prop({ default: 0 }) checkRound: number;
  @Prop({ default: false }) checkOpen: boolean;
  @Prop({ type: Date }) checkDueAt?: Date;
  @Prop({ default: 0 }) issueRound: number;
  @Prop({ default: false }) issueOpen: boolean;
  @Prop({ type: Date }) issueDueAt?: Date;
}

export const PharmacyOrderSchema = SchemaFactory.createForClass(PharmacyOrder);
// Unique only among orders that have a prescription.
PharmacyOrderSchema.index({ prescription: 1 }, { unique: true, partialFilterExpression: { prescription: { $type: 'objectId' } } });
PharmacyOrderSchema.index({ announcedAt: 1 });
PharmacyOrderSchema.index({ createdAt: -1 });
