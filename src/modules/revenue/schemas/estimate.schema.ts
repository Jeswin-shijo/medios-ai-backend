import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ActorRef, ActorRefSchema } from './actor-ref';

export type EstimateDocument = Estimate & Document;

@Schema({ _id: false })
export class EstimateLine {
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) amount: number;
}
export const EstimateLineSchema = SchemaFactory.createForClass(EstimateLine);

@Schema({ timestamps: true })
export class Estimate {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  bill: Types.ObjectId;

  @Prop({ type: [EstimateLineSchema], default: [] })
  lines: EstimateLine[];

  @Prop({ required: true })
  days: number;

  @Prop({ required: true })
  total: number;

  @Prop({ required: true })
  low: number;

  @Prop({ required: true })
  high: number;

  @Prop({ type: ActorRefSchema, required: true })
  by: ActorRef;

  @Prop({ type: Date, required: true })
  at: Date;

  @Prop({ type: Date })
  announcedAt?: Date;
}

export const EstimateSchema = SchemaFactory.createForClass(Estimate);
