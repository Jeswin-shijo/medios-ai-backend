import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { ActorRef, ActorRefSchema } from '../../revenue/schemas/actor-ref';
import { COMPLETION_KINDS, CONDITIONS, CompletionKind, Condition, DISCHARGE_KINDS, DischargeKind, LINE_KEYS, LineKey } from '../discharge-catalogue';

export type DischargeOrderDocument = DischargeOrder & Document;

export const ORDER_STATES = ['ordered', 'ready', 'left', 'cancelled'] as const;
export type OrderState = (typeof ORDER_STATES)[number];
/** An order in progress: given, the patient not yet gone. */
export const OPEN_ORDER_STATES: OrderState[] = ['ordered', 'ready'];
/** An order that holds its plan: in progress, or the patient has left. The unique index allows one per plan. */
export const LIVE_ORDER_STATES: OrderState[] = ['ordered', 'ready', 'left'];

export const LINE_STATES = ['done', 'waiting', 'not-needed', 'needs-person'] as const;
export type LineState = (typeof LINE_STATES)[number];

/** One checklist line. `by`, `at` and `note` record a hand tick, a "not needed" or the no-bill override; `detail` is the panel's short text. */
@Schema({ _id: false })
export class DischargeLineEntry {
  @Prop({ type: String, required: true, enum: LINE_KEYS }) key: LineKey;
  @Prop({ type: String, required: true, enum: LINE_STATES }) state: LineState;
  @Prop({ type: ActorRefSchema }) by?: ActorRef;
  /** Clinic clock. */
  @Prop({ type: Date }) at?: Date;
  @Prop() note?: string;
  /** For the panel, such as "₹2,340 due · 1 line needs a price". */
  @Prop() detail?: string;
}
export const DischargeLineEntrySchema = SchemaFactory.createForClass(DischargeLineEntry);

/** The outcome of the Scheduling follow-up order. */
@Schema({ _id: false })
export class DischargeFollowUp {
  @Prop({ required: true }) followUpId: string;
  @Prop({ type: String, required: true, enum: ['booked', 'waitlisted'] }) status: 'booked' | 'waitlisted';
  @Prop() appointmentId?: string;
  @Prop() date?: string;
  @Prop() time?: string;
}
export const DischargeFollowUpSchema = SchemaFactory.createForClass(DischargeFollowUp);

@Schema({ _id: false })
export class DischargeCancel {
  @Prop({ type: ActorRefSchema, required: true }) by: ActorRef;
  @Prop({ required: true }) reason: string;
  /** Clinic clock. */
  @Prop({ type: Date, required: true }) at: Date;
}
export const DischargeCancelSchema = SchemaFactory.createForClass(DischargeCancel);

/** Who pressed Start now, and when (clinic clock). */
@Schema({ _id: false })
export class DischargeStartNow {
  @Prop({ type: ActorRefSchema, required: true }) by: ActorRef;
  @Prop({ type: Date, required: true }) at: Date;
}
export const DischargeStartNowSchema = SchemaFactory.createForClass(DischargeStartNow);

@Schema({ _id: false })
export class GatePass {
  /** GP-0001. */
  @Prop({ required: true }) number: string;
  /** Every print, the first included (clinic clock). */
  @Prop({ type: [Date], default: [] }) printedAt: Date[];
  @Prop({ type: ActorRefSchema, required: true }) by: ActorRef;
  /**
   * R49: what the pass said about money at its latest print while the order was Ready, so a reprint after leaving is
   * a copy of the pass the patient left with, never today's bills. Absent on a pass printed before R49.
   */
  @Prop() billLine?: string;
}
export const GatePassSchema = SchemaFactory.createForClass(GatePass);

/** Who received the body (Died). */
@Schema({ _id: false })
export class BodyReceiver {
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) relationship: string;
}
export const BodyReceiverSchema = SchemaFactory.createForClass(BodyReceiver);

/** The doctor's discharge order and its checklist. Times are on the clinic clock unless marked real. */
@Schema({ timestamps: true })
export class DischargeOrder {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  plan: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  admission: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId })
  case?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  patient: Types.ObjectId;

  @Prop({ type: String, required: true, enum: DISCHARGE_KINDS })
  kind: DischargeKind;

  @Prop({ type: String, required: true, enum: ORDER_STATES, default: 'ordered' })
  state: OrderState;

  @Prop({ type: Date, required: true })
  plannedLeaveAt: Date;

  /** When the discharge window opens: the later of the order time and the planned leaving time less the target; Start now sets it to now. */
  @Prop({ type: Date, required: true })
  windowAt: Date;

  /** Real time `discharge.window-opened` was sent. */
  @Prop({ type: Date })
  windowOpenedAt?: Date;

  @Prop({ type: DischargeStartNowSchema })
  startedNow?: DischargeStartNow;

  @Prop({ required: true })
  diagnosis: string;

  /** Not asked for Died. */
  @Prop({ type: String, enum: CONDITIONS })
  condition?: Condition;

  @Prop({ type: Date })
  timeOfDeath?: Date;

  @Prop()
  causeOfDeath?: string;

  @Prop()
  receivingHospital?: string;

  @Prop()
  transferReason?: string;

  /** The doctor's note for the summary. Never sent to the AI. */
  @Prop({ default: '' })
  note: string;

  /** The Pharmacy take-home order: the first one, placed with the order or by the first edit that adds medicines. */
  @Prop({ type: MongooseSchema.Types.ObjectId })
  takeHomeOrder?: Types.ObjectId;

  /** Later take-home orders: an edit that adds medicines to an order that has one places another (see `takeHomeOrderIds`). */
  @Prop({ type: [MongooseSchema.Types.ObjectId], default: [] })
  addedTakeHomeOrders: Types.ObjectId[];

  @Prop({ default: false })
  noTakeHome: boolean;

  @Prop({ type: DischargeFollowUpSchema })
  followUp?: DischargeFollowUp;

  @Prop({ default: false })
  noFollowUp: boolean;

  /** Lab request ids the doctor marked "follow up later". */
  @Prop({ type: [String], default: [] })
  followUpLater: string[];

  @Prop({ type: [DischargeLineEntrySchema], default: [] })
  lines: DischargeLineEntry[];

  @Prop({ type: ActorRefSchema, required: true })
  orderedBy: ActorRef;

  @Prop({ type: Date, required: true })
  orderedAt: Date;

  @Prop({ type: DischargeCancelSchema })
  cancelled?: DischargeCancel;

  @Prop({ type: GatePassSchema })
  gatePass?: GatePass;

  @Prop({ type: Date })
  leftAt?: Date;

  @Prop({ type: ActorRefSchema })
  leftBy?: ActorRef;

  /**
   * How the stay ended (R21): the order's own kind at Patient left or Body released; `left-without-discharge` when a
   * patient who had already gone was recorded. Only an order whose `endedAs` is its `kind` is timed as a discharge.
   */
  @Prop({ type: String, enum: COMPLETION_KINDS })
  endedAs?: CompletionKind;

  @Prop({ type: BodyReceiverSchema })
  bodyReceiver?: BodyReceiver;

  /** The message types sent for this order; the one-minute pass re-sends one a record says is due but is missing here. */
  @Prop({ type: [String], default: [] })
  announced: string[];

  /**
   * How many times the order became Ready (R31): `discharge.ready` goes with the dedupe key
   * `discharge.ready:<orderId>:<readyCount>`, so a Ready lost and regained within the Coordinator's minute is
   * announced again. Losing Ready takes `discharge.ready` out of `announced`, so a send that failed is due again.
   */
  @Prop({ default: 0 })
  readyCount: number;
}

/** Every Pharmacy take-home order of a discharge order, the first one first. */
export const takeHomeOrderIds = (o: Pick<DischargeOrder, 'takeHomeOrder' | 'addedTakeHomeOrders'>): string[] => [
  ...(o.takeHomeOrder ? [String(o.takeHomeOrder)] : []),
  ...(o.addedTakeHomeOrders ?? []).map(String),
];

export const DischargeOrderSchema = SchemaFactory.createForClass(DischargeOrder);
// One order per plan that is not cancelled. `left` counts too, so a plan whose patient has left is never ordered again.
DischargeOrderSchema.index({ plan: 1 }, { unique: true, partialFilterExpression: { state: { $in: LIVE_ORDER_STATES } } });
DischargeOrderSchema.index({ state: 1, windowAt: 1 });
