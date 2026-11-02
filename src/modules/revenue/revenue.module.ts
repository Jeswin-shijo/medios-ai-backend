import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Ward, WardSchema } from '../beds/schemas/ward.schema';
import { OpDoctor, OpDoctorSchema } from '../opd/schemas/op-doctor.schema';
import { SettingsModule } from '../settings/settings.module';
import { CoordinatorModule } from '../coordinator/coordinator.module';
import { Patient, PatientSchema } from '../patients/schemas/patient.schema';
import { PriceListService } from './price-list.service';
import { RevenueSettingsService } from './revenue-settings.service';
import { RevenueBillsService } from './revenue-bills.service';
import { Bill, BillSchema } from './schemas/bill.schema';
import { ChargeLine, ChargeLineSchema } from './schemas/charge-line.schema';
import { Correction, CorrectionSchema } from './schemas/correction.schema';
import { Estimate, EstimateSchema } from './schemas/estimate.schema';
import { Payment, PaymentSchema } from './schemas/payment.schema';
import { PriceItem, PriceItemSchema } from './schemas/price-item.schema';
import { Refund, RefundSchema } from './schemas/refund.schema';
import { RevenueSnapshot, RevenueSnapshotSchema } from './schemas/revenue-snapshot.schema';

/**
 * The Revenue agent. It reads other agents' records read-only through their models and never imports their services.
 * Later tasks add the bills, the controller and the scheduler here.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PriceItem.name, schema: PriceItemSchema },
      { name: Ward.name, schema: WardSchema },
      { name: OpDoctor.name, schema: OpDoctorSchema },
      { name: Patient.name, schema: PatientSchema },
      { name: Bill.name, schema: BillSchema },
      { name: ChargeLine.name, schema: ChargeLineSchema },
      { name: Estimate.name, schema: EstimateSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: Refund.name, schema: RefundSchema },
      { name: Correction.name, schema: CorrectionSchema },
      { name: RevenueSnapshot.name, schema: RevenueSnapshotSchema },
    ]),
    SettingsModule,
    CoordinatorModule, // the counter model
  ],
  providers: [PriceListService, RevenueSettingsService, RevenueBillsService],
  exports: [PriceListService, RevenueSettingsService, RevenueBillsService],
})
export class RevenueModule {}
