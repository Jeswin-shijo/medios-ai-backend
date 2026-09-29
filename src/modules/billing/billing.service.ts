import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BillInvoice, BillInvoiceDocument } from './schemas/bill.schema';

@Injectable()
export class BillingService {
  constructor(
    @InjectModel(BillInvoice.name)
    private billModel: Model<BillInvoiceDocument>,
  ) {}

  async findAll(query: { uhid?: string; status?: string }): Promise<BillInvoice[]> {
    const filter: any = {};
    if (query.uhid) filter.uhid = query.uhid;
    if (query.status && query.status !== 'All' && query.status !== 'All Bills') {
      filter.status = query.status;
    }

    return this.billModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  async findOne(id: string): Promise<BillInvoiceDocument> {
    const bill = await this.billModel.findById(id).exec();
    if (!bill) throw new NotFoundException(`Invoice ${id} not found`);
    return bill;
  }

  async create(data: Partial<BillInvoice>): Promise<BillInvoiceDocument> {
    if (!data.billNumber) {
      data.billNumber = `INV-${Date.now().toString().slice(-6)}`;
    }
    const created = new this.billModel(data);
    return created.save();
  }

  async recordPayment(id: string, amount: number, paymentMode?: string): Promise<BillInvoiceDocument> {
    const bill = await this.findOne(id);
    bill.paidAmount = (bill.paidAmount || 0) + amount;
    bill.balanceDue = Math.max(0, bill.totalAmount - bill.paidAmount);
    if (paymentMode) bill.paymentMode = paymentMode;

    if (bill.balanceDue === 0) {
      bill.status = 'Paid';
    } else if (bill.paidAmount > 0) {
      bill.status = 'Partially Paid';
    }

    return bill.save();
  }

  async getStats() {
    const bills = await this.billModel.find({}).exec();
    const totalRevenue = bills.reduce((acc, b) => acc + (b.paidAmount || 0), 0);
    const pendingDue = bills.reduce((acc, b) => acc + (b.balanceDue || 0), 0);
    const paidCount = bills.filter(b => b.status === 'Paid').length;
    const unpaidCount = bills.filter(b => b.status === 'Unpaid').length;

    return {
      todayRevenue: 24850,
      totalRevenue,
      pendingDue,
      totalInvoices: bills.length,
      paidInvoices: paidCount,
      unpaidInvoices: unpaidCount,
      currency: 'INR (₹)',
    };
  }
}
