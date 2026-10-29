import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LadderDocument = Ladder & Document;

export interface LadderStep {
  /** A duty title key. */
  title: string;
  /** Minutes to wait before moving to the next step. Ignored on the last step. */
  waitMinutes: number;
}

/** Who an escalation goes to, step by step. */
@Schema({ timestamps: true })
export class Ladder {
  @Prop({ required: true, unique: true }) key: string;
  @Prop({ required: true }) label: string;
  @Prop({ type: [{ title: { type: String, required: true }, waitMinutes: { type: Number, required: true } }], default: [], _id: false })
  steps: LadderStep[];
}

export const LadderSchema = SchemaFactory.createForClass(Ladder);
