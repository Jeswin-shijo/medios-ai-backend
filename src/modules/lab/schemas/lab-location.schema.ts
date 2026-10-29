import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type LabLocationDocument = LabLocation & Document;
export type LabArea = 'ER' | 'Ward' | 'OPD';

/** Where a case's patient is now, learnt from ER and Bed messages. */
@Schema({ timestamps: true })
export class LabLocation {
  @Prop({ required: true, unique: true, type: MongooseSchema.Types.ObjectId }) case: Types.ObjectId;
  @Prop({ required: true, type: String, enum: ['ER', 'Ward', 'OPD'] }) area: LabArea;
  @Prop() ward?: string;
}

export const LabLocationSchema = SchemaFactory.createForClass(LabLocation);
