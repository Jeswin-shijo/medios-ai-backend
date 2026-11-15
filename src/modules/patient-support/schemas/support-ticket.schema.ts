import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { PRIORITIES, TICKET_SOURCES, TICKET_STATES, TICKET_TYPES } from '../support-catalogue';

export type SupportTicketDocument = SupportTicket & Document;

export const NOTE_KINDS = ['note', 'state', 'hand-on', 'resolve', 'system'] as const;

@Schema({ _id: false })
export class TicketNote {
  @Prop({ type: String, required: true, enum: NOTE_KINDS }) kind: (typeof NOTE_KINDS)[number];
  @Prop({ required: true }) text: string;
  @Prop({ required: true }) by: string;
  @Prop({ required: true }) byName: string;
  @Prop({ type: Date, required: true }) at: Date;
}
export const TicketNoteSchema = SchemaFactory.createForClass(TicketNote);

/** One caller's question or complaint, owned by a person or duty title until it is resolved. */
@Schema({ timestamps: true })
export class SupportTicket {
  /** SP-0001. */
  @Prop({ required: true, unique: true }) number: string;

  @Prop({ type: MongooseSchema.Types.ObjectId }) patient?: Types.ObjectId;
  @Prop() patientUhid?: string;
  @Prop() patientName?: string;
  @Prop({ type: MongooseSchema.Types.ObjectId }) case?: Types.ObjectId;

  @Prop({ default: '' }) callerName: string;
  @Prop({ default: '' }) callerPhone: string;

  @Prop({ required: true, enum: TICKET_TYPES }) ticketType: string;
  @Prop({ required: true }) owner: string;
  @Prop({ required: true }) ladder: string;
  @Prop({ required: true, enum: PRIORITIES, default: 'normal' }) priority: string;
  @Prop({ required: true, enum: TICKET_SOURCES }) source: string;
  @Prop({ required: true, enum: ['desk', 'phone'], default: 'desk' }) channel: string;
  @Prop({ required: true, maxlength: 1000 }) question: string;

  @Prop({ required: true, enum: TICKET_STATES, default: 'open' }) state: string;
  /** Starts at 1; goes up by one each time the ticket is handed on. */
  @Prop({ required: true, default: 1 }) round: number;
  @Prop({ type: Date }) roundAnsweredAt?: Date;
  @Prop({ type: Date }) answeredAt?: Date;
  @Prop() firstResponseMinutes?: number;
  @Prop({ type: Date, required: true }) dueAt: Date;
  @Prop({ type: Date }) escalatedAt?: Date;

  @Prop({ type: [TicketNoteSchema], default: [] }) notes: TicketNote[];

  @Prop({ type: Date }) resolvedAt?: Date;
  @Prop() resolvedByName?: string;
  @Prop() resolution?: string;

  /** One ticket per provider call id. */
  @Prop() providerCallId?: string;
  @Prop({ type: MongooseSchema.Types.ObjectId }) agentCall?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId }) feedback?: Types.ObjectId;
  @Prop({ required: true }) openedById: string;
  @Prop({ required: true }) openedByName: string;
  @Prop({ type: Date, required: true }) openedAt: Date;
  /** Opened at the desk as already answered. */
  @Prop({ required: true, default: false }) onTheSpot: boolean;
}

export const SupportTicketSchema = SchemaFactory.createForClass(SupportTicket);
SupportTicketSchema.index({ state: 1, dueAt: 1 });
SupportTicketSchema.index({ providerCallId: 1 }, { unique: true, sparse: true });
