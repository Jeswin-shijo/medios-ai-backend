import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { displayDate } from '../../../common/utils/clinic-time';

export type BillInvoiceDocument = BillInvoice & Document;

@Schema()
export class BillItem {
  @Prop({ required: true })
  service: string;

  @Prop({ default: '' })
  subCategory: string;

  @Prop({
    default: 'Consultation',
    enum: ['Consultation', 'Lab', 'Radiology', 'Others', 'Administrative'],
  })
  category: string;

  @Prop({ default: 1 })
  qty: number;

  @Prop({ required: true })
  unitPrice: number;

  @Prop({ default: 0 })
  discount: number;

  @Prop({ required: true })
  amount: number;
}

@Schema({ timestamps: true })
export class BillInvoice {
  @Prop({ required: true, unique: true, index: true })
  billNumber: string;

  @Prop({ required: true, index: true })
  uhid: string;

  @Prop({ required: true })
  patientName: string;

  @Prop({ default: () => displayDate() })
  billDate: string;

  @Prop({ default: '' })
  visitType: string;

  @Prop({ default: '' })
  consultationId: string;

  @Prop({ default: '' })
  createdBy: string;

  @Prop({ default: '' })
  paymentMode: string;

  // Derived from paidAmount vs totalAmount by BillingService; never assume payment.
  @Prop({
    default: 'Unpaid',
    enum: ['Paid', 'Unpaid', 'Partially Paid'],
  })
  status: string;

  @Prop({ type: [BillItem], default: [] })
  items: BillItem[];

  @Prop({ required: true })
  subtotal: number;

  @Prop({ default: 0 })
  discount: number;

  @Prop({ default: 0 })
  tax: number;

  @Prop({ required: true })
  totalAmount: number;

  @Prop({ default: 0 })
  paidAmount: number;

  @Prop({ default: 0 })
  balanceDue: number;

  @Prop({ default: '' })
  notes: string;
}

export const BillInvoiceSchema = SchemaFactory.createForClass(BillInvoice);
