import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import * as mongoose from 'mongoose';
import { displayDate } from '../../common/utils/clinic-time';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { BillInvoice, BillInvoiceSchema } from '../billing/schemas/bill.schema';
import { Consultation, ConsultationSchema } from '../consultations/schemas/consultation.schema';
import { ImagingStudy, ImagingStudySchema } from '../imaging/schemas/imaging.schema';
import { UserRole } from '../users/schemas/user.schema';
import { DashboardService } from './dashboard.service';

const reg = (c: any, schema: any) => (mongoose.models[c.name] ?? mongoose.model(c.name, schema)) as mongoose.Model<any>;
const BY = { id: 'u1', name: 'Desk' };

describe('DashboardService billing numbers', () => {
  const m = models();
  const Invoice = () => reg(BillInvoice, BillInvoiceSchema);
  const build = () =>
    new DashboardService(m.Patient, m.Appointment, m.LabTestReport, reg(ImagingStudy, ImagingStudySchema), Invoice(), reg(Consultation, ConsultationSchema), m.TaskAlertItem, m.Payment, m.Bill);
  const day = new Date(2026, 9, 20, 10, 0, 0);
  let seq = 0;
  const bill = (over: Record<string, unknown> = {}) => {
    const n = ++seq;
    return m.Bill.create({ number: `BL-${n}`, patient: new mongoose.Types.ObjectId(), patientUhid: 'U', patientName: 'P', kind: 'er', state: 'open', openedAt: day, erVisit: new mongoose.Types.ObjectId(), totals: { charges: 0, discounts: 0, payments: 0, refunds: 0, balance: 0 }, ...over });
  };
  const pay = (b: any, amount: number, over: Record<string, unknown> = {}) => {
    const n = ++seq;
    return m.Payment.create({ receiptNumber: `RC-${n}`, bill: b._id, amount, mode: 'cash', kind: 'part', by: BY, at: day, ...over });
  };

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(resetTestDb);

  test('the dashboard revenue counts today\'s Revenue payments, minus cancelled ones, plus legacy invoices paid today', async () => {
    const b = await bill();
    await pay(b, 1000);
    await pay(b, 500);
    await pay(b, 300, { cancelled: { at: day, by: BY, reason: 'oops' } });
    await pay(b, 9999, { at: new Date(2026, 9, 19, 23, 0, 0) });
    await Invoice().collection.insertMany([
      { billDate: displayDate(day), paidAmount: 200, totalAmount: 200, status: 'Paid' },
      { billDate: '01 Jan 2020', paidAmount: 777, totalAmount: 777, status: 'Paid' },
    ]);
    const out = await build().getDashboardStats(day, UserRole.ADMIN);
    assert.equal(out.billing.revenue, 1700);
  });

  test('invoices are the bills opened today plus the legacy invoices of today', async () => {
    await bill();
    await bill({ kind: 'opd', erVisit: undefined });
    await bill({ openedAt: new Date(2026, 9, 18, 9, 0, 0) });
    await Invoice().collection.insertMany([{ billDate: displayDate(day), paidAmount: 0, totalAmount: 50, status: 'Unpaid' }]);
    const out = await build().getDashboardStats(day, UserRole.ADMIN);
    assert.equal(out.billing.invoices, 3);
  });

  test('billing is shown to admin and staff only; doctor, nurse, pharmacist and lab get null (R37)', async () => {
    const b = await bill();
    await pay(b, 400);
    for (const role of [UserRole.ADMIN, UserRole.STAFF]) {
      const out = await build().getDashboardStats(day, role);
      assert.deepEqual(out.billing, { revenue: 400, invoices: 1 }, role);
    }
    for (const role of [UserRole.DOCTOR, UserRole.NURSE, UserRole.PHARMACIST, UserRole.LAB]) {
      const out = await build().getDashboardStats(day, role);
      assert.equal(out.billing, null, role);
    }
  });
});
