import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import type { PharmacySetting } from './pharmacy-order.schema';

export type PharmacyLocationDocument = PharmacyLocation & Document;

/** Where a case's patient is now, learnt from ER and Bed messages. */
@Schema({ timestamps: true })
export class PharmacyLocation {
  @Prop({ required: true, unique: true, type: MongooseSchema.Types.ObjectId }) case: Types.ObjectId;
  @Prop({ required: true, type: String, enum: ['ER', 'Ward', 'OPD'] }) area: PharmacySetting;
  @Prop() ward?: string;
}

export const PharmacyLocationSchema = SchemaFactory.createForClass(PharmacyLocation);
