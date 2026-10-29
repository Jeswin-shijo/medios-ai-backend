import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ER_MODES, ErMode } from './er-visit.schema';

export type ErExpectedDocument = ErExpected & Document;

/** A heads-up that someone is on the way (an ambulance call, a referral). */
@Schema({ timestamps: true })
export class ErExpected {
  @Prop({ required: true }) complaint: string;
  @Prop({ required: true }) ageSex: string;
  @Prop({ required: true, type: String, enum: ER_MODES }) mode: ErMode;
  @Prop({ required: true }) etaMinutes: number;
  /** Clinic clock. */
  @Prop({ required: true }) expectedAt: Date;
  @Prop() phone?: string;
  @Prop({ type: Types.ObjectId, ref: 'Patient' }) patient?: Types.ObjectId;
  @Prop({ required: true, type: String, enum: ['waiting', 'arrived', 'expired'], default: 'waiting' }) state: 'waiting' | 'arrived' | 'expired';
  @Prop() byName?: string;
}

export const ErExpectedSchema = SchemaFactory.createForClass(ErExpected);
