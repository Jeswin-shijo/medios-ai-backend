import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type QueueDisplayDocument = QueueDisplay & Document;

/**
 * - `display`: a screen that shows the queue, such as the waiting-room TV.
 * - `kiosk`: a check-in point where patients tap their card on a reader to take a token.
 */
export const DEVICE_KINDS = ['display', 'kiosk'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/**
 * A device allowed to use the queue without a staff sign-in. It holds a random key;
 * only the key's SHA-256 is stored, so the key is shown once when the device is
 * added. Removing the device revokes it.
 */
@Schema({ timestamps: true })
export class QueueDisplay {
  @Prop({ required: true })
  name: string;

  @Prop({ default: 'display', enum: DEVICE_KINDS })
  kind: string;

  @Prop({ required: true, unique: true, select: false })
  keyHash: string;

  /** The key's last characters, so staff can tell links apart. */
  @Prop({ required: true })
  keyHint: string;

  /** Kiosk: print a token slip after each tap (on the kiosk computer's default printer). */
  @Prop({ default: false })
  printSlips: boolean;

  @Prop({ default: '' })
  createdBy: string;

  @Prop()
  lastSeenAt?: Date;
}

export const QueueDisplaySchema = SchemaFactory.createForClass(QueueDisplay);
