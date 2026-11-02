import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ErVisit, ErVisitSchema } from '../er/schemas/er-visit.schema';
import { LabLine, LabLineSchema } from '../lab/schemas/lab-line.schema';
import { LabRequest, LabRequestSchema } from '../lab/schemas/lab-request.schema';
import { PharmacyLine, PharmacyLineSchema } from '../pharmacy/schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderSchema } from '../pharmacy/schemas/pharmacy-order.schema';
import { ConsultRequest, ConsultRequestSchema } from '../scheduling/schemas/consult-request.schema';
import { ProcedureBooking, ProcedureBookingSchema } from '../scheduling/schemas/procedure-booking.schema';
import { RevenueCaptureService } from './revenue-capture.service';
import { Admission, AdmissionSchema } from '../beds/schemas/admission.schema';
import { Bed, BedSchema } from '../beds/schemas/bed.schema';
import { Ward, WardSchema } from '../beds/schemas/ward.schema';
import { Case, CaseSchema } from '../coordinator/schemas/case.schema';
import { RevenueBedDaysService } from './revenue-bed-days.service';
import { RevenueDepositsService } from './revenue-deposits.service';
import { RevenueEstimatesService } from './revenue-estimates.service';
import { RevenueOpdService } from './revenue-opd.service';
import { AppointmentsModule } from '../appointments/appointments.module';
import { OpdModule } from '../opd/opd.module';
import { Appointment, AppointmentSchema } from '../appointments/schemas/appointment.schema';
import { OpDoctor, OpDoctorSchema } from '../opd/schemas/op-doctor.schema';
import { SettingsModule } from '../settings/settings.module';
import { CoordinatorModule } from '../coordinator/coordinator.module';
import { Patient, PatientSchema } from '../patients/schemas/patient.schema';
import { TaskAlertItem, TaskAlertItemSchema } from '../tasks-alerts/schemas/task-alert.schema';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
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
      { name: Bed.name, schema: BedSchema },
      { name: Admission.name, schema: AdmissionSchema },
      { name: Case.name, schema: CaseSchema },
      { name: OpDoctor.name, schema: OpDoctorSchema },
      { name: Appointment.name, schema: AppointmentSchema },
      { name: Patient.name, schema: PatientSchema },
      { name: Bill.name, schema: BillSchema },
      { name: ChargeLine.name, schema: ChargeLineSchema },
      { name: Estimate.name, schema: EstimateSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: Refund.name, schema: RefundSchema },
      { name: Correction.name, schema: CorrectionSchema },
      { name: RevenueSnapshot.name, schema: RevenueSnapshotSchema },
      { name: TaskAlertItem.name, schema: TaskAlertItemSchema },
      // Other agents' records, read-only.
      { name: ErVisit.name, schema: ErVisitSchema },
      { name: LabRequest.name, schema: LabRequestSchema },
      { name: LabLine.name, schema: LabLineSchema },
      { name: PharmacyLine.name, schema: PharmacyLineSchema },
      { name: PharmacyOrder.name, schema: PharmacyOrderSchema },
      { name: ProcedureBooking.name, schema: ProcedureBookingSchema },
      { name: ConsultRequest.name, schema: ConsultRequestSchema },
    ]),
    SettingsModule,
    CoordinatorModule, // the counter model
    AppointmentsModule, // AppointmentEvents
    OpdModule,
  ],
  providers: [PriceListService, RevenueSettingsService, RevenueBillsService, RevenueCoordinatorRegistration, RevenueCaptureService, RevenueBedDaysService, RevenueOpdService, RevenueEstimatesService, RevenueDepositsService],
  exports: [PriceListService, RevenueSettingsService, RevenueBillsService, RevenueCoordinatorRegistration, RevenueCaptureService, RevenueBedDaysService, RevenueOpdService, RevenueEstimatesService, RevenueDepositsService],
})
export class RevenueModule {}
