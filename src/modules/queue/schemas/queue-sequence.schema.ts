import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type QueueSequenceDocument = QueueSequence & Document;

/** The last token number handed out on a day; incremented atomically. */
@Schema()
export class QueueSequence {
  @Prop({ required: true, unique: true })
  date: string;

  @Prop({ default: 0 })
  last: number;
}

export const QueueSequenceSchema = SchemaFactory.createForClass(QueueSequence);
