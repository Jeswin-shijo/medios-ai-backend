import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CoordinatorCounterDocument = CoordinatorCounter & Document;

/** Running numbers for the Coordinator, one document per key (for example the case number). */
@Schema()
export class CoordinatorCounter {
  @Prop({ required: true, unique: true }) key: string;
  @Prop({ default: 0 }) last: number;
}

export const CoordinatorCounterSchema = SchemaFactory.createForClass(CoordinatorCounter);
