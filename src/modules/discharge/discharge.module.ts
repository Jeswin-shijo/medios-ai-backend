import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiModule } from '../ai/ai.module';
import { BedsModule } from '../beds/beds.module';
import { Admission, AdmissionSchema } from '../beds/schemas/admission.schema';
import { Bed, BedSchema } from '../beds/schemas/bed.schema';
import { Ward, WardSchema } from '../beds/schemas/ward.schema';
import { CoordinatorModule } from '../coordinator/coordinator.module';
import { Case, CaseSchema } from '../coordinator/schemas/case.schema';
import { DocumentsModule } from '../documents/documents.module';
import { FollowUpItem, FollowUpItemSchema } from '../follow-ups/schemas/follow-up.schema';
import { LabLine, LabLineSchema } from '../lab/schemas/lab-line.schema';
import { LabRequest, LabRequestSchema } from '../lab/schemas/lab-request.schema';
import { PatientsModule } from '../patients/patients.module';
import { PharmacyModule } from '../pharmacy/pharmacy.module';
import { PharmacyLine, PharmacyLineSchema } from '../pharmacy/schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderSchema } from '../pharmacy/schemas/pharmacy-order.schema';
import { Bill, BillSchema } from '../revenue/schemas/bill.schema';
import { ChargeLine, ChargeLineSchema } from '../revenue/schemas/charge-line.schema';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { ProcedureBooking, ProcedureBookingSchema } from '../scheduling/schemas/procedure-booking.schema';
import { SettingsModule } from '../settings/settings.module';
import { TaskAlertItem, TaskAlertItemSchema } from '../tasks-alerts/schemas/task-alert.schema';
import { TimelineModule } from '../timeline/timeline.module';
import { DischargeAiService } from './discharge-ai';
import { DischargeRegistration } from './discharge-coordinator.registration';
import { DischargeLeavingService } from './discharge-leaving.service';
import { DischargeLinesService } from './discharge-lines.service';
import { DischargeOrdersService } from './discharge-orders.service';
import { DischargeOverviewService } from './discharge-overview.service';
import { DischargePlansService } from './discharge-plans.service';
import { DischargeSettingsService } from './discharge-settings.service';
import { DischargeSummaryService } from './discharge-summary.service';
import { DischargeController } from './discharge.controller';
// The same schema objects the Bed Agent and Revenue register (one model name, one schema).
import { DischargeOrder, DischargeOrderSchema } from './schemas/discharge-order.schema';
import { DischargePlan, DischargePlanSchema } from './schemas/discharge-plan.schema';
import { DischargeSnapshot, DischargeSnapshotSchema } from './schemas/discharge-snapshot.schema';
import { DischargeSummary, DischargeSummarySchema } from './schemas/discharge-summary.schema';

/**
 * The Discharge agent. It reads the other agents' records read-only through its own models, and changes them only
 * through the services those agents export: Beds (`BedsService`: the leaving badge and ending a stay), Pharmacy
 * (`PharmacyTakeHomeService`), Scheduling (`SchedulingFollowupsService`), Documents and Timeline (the signed summary),
 * and the Coordinator (cases, messages, rules, escalations, the counter model). Nothing imports this module, so no
 * module cycle forms.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DischargePlan.name, schema: DischargePlanSchema },
      { name: DischargeOrder.name, schema: DischargeOrderSchema },
      { name: DischargeSummary.name, schema: DischargeSummarySchema },
      { name: DischargeSnapshot.name, schema: DischargeSnapshotSchema },
      // Other agents' records, read-only.
      { name: Admission.name, schema: AdmissionSchema },
      { name: Bed.name, schema: BedSchema },
      { name: Ward.name, schema: WardSchema },
      { name: Case.name, schema: CaseSchema },
      { name: LabRequest.name, schema: LabRequestSchema },
      { name: LabLine.name, schema: LabLineSchema },
      { name: PharmacyOrder.name, schema: PharmacyOrderSchema },
      { name: PharmacyLine.name, schema: PharmacyLineSchema },
      { name: FollowUpItem.name, schema: FollowUpItemSchema },
      { name: Bill.name, schema: BillSchema },
      { name: ChargeLine.name, schema: ChargeLineSchema },
      { name: TaskAlertItem.name, schema: TaskAlertItemSchema },
      { name: ProcedureBooking.name, schema: ProcedureBookingSchema },
    ]),
    SettingsModule,
    CoordinatorModule, // registry, messages, cases, rules, escalations, and the counter model (GP numbers)
    PatientsModule, // PatientEvents and the patient model
    DocumentsModule, // the signed summary's Documents record
    TimelineModule,
    AiModule,
    BedsModule, // BedsService
    PharmacyModule, // PharmacyTakeHomeService
    SchedulingModule, // SchedulingFollowupsService
  ],
  controllers: [DischargeController],
  providers: [
    DischargeSettingsService,
    DischargeRegistration,
    DischargePlansService,
    DischargeLinesService,
    DischargeSummaryService,
    DischargeOrdersService,
    DischargeLeavingService,
    DischargeAiService,
    DischargeOverviewService,
  ],
  exports: [DischargeSettingsService, DischargePlansService, DischargeOrdersService, DischargeLinesService, DischargeSummaryService, DischargeLeavingService, DischargeOverviewService],
})
export class DischargeModule {}
