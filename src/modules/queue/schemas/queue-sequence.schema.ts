import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type QueueSequenceDocument = QueueSequence & Document;

/** The last token number handed out on a day in one series (a doctor's line); incremented atomically. */
@Schema()
export class QueueSequence {
  @Prop({ required: true })
  date: string;

  /** The doctor's id; '' (or absent, on old records) for the hospital-wide line. */
  @Prop({ default: '' })
  series: string;

  @Prop({ default: 0 })
  last: number;
}

export const QueueSequenceSchema = SchemaFactory.createForClass(QueueSequence);
QueueSequenceSchema.index({ date: 1, series: 1 }, { unique: true });
