import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RoomBlockDocument = RoomBlock & Document & { createdAt?: Date; updatedAt?: Date };

/** A room closed for a period (maintenance, deep clean). Clinic clock. */
@Schema({ timestamps: true })
export class RoomBlock {
  @Prop({ required: true, index: true }) room: string;
  @Prop({ required: true, type: Date }) from: Date;
  @Prop({ required: true, type: Date }) to: Date;
  @Prop({ default: '' }) reason: string;
  @Prop({ required: true, type: { id: String, name: String }, _id: false }) by: { id: string; name: string };
}

export const RoomBlockSchema = SchemaFactory.createForClass(RoomBlock);
