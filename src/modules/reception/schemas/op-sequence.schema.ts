import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type OpSequenceDocument = OpSequence & Document;

/** The last OP number given out on a clinic day; incremented atomically when a visit is paid. */
@Schema()
export class OpSequence {
  /** The clinic day, YYYY-MM-DD. */
  @Prop({ required: true, unique: true })
  date: string;

  @Prop({ default: 0 })
  last: number;
}

export const OpSequenceSchema = SchemaFactory.createForClass(OpSequence);
