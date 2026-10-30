import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiModule } from '../ai/ai.module';
import { CoordinatorModule } from '../coordinator/coordinator.module';
import { LabReportsModule } from '../lab-reports/lab-reports.module';
import { PatientsModule } from '../patients/patients.module';
import { Prescription, PrescriptionSchema } from '../prescriptions/schemas/prescription.schema';
import { SettingsModule } from '../settings/settings.module';
import { TasksAlertsModule } from '../tasks-alerts/tasks-alerts.module';
import { PharmacyAiService } from './pharmacy-ai';
import { PharmacyChecksService } from './pharmacy-checks.service';
import { PharmacyCoordinatorRegistration } from './pharmacy-coordinator.registration';
import { PharmacyIssueService } from './pharmacy-issue.service';
import { PharmacyOrdersService } from './pharmacy-orders.service';
import { PharmacyOverviewService } from './pharmacy-overview.service';
import { PharmacyPatientsService } from './pharmacy-patients.service';
import { PharmacyReconcileService } from './pharmacy-reconcile.service';
import { PharmacySettingsService } from './pharmacy-settings.service';
import { PharmacyStockService } from './pharmacy-stock.service';
import { PharmacyController } from './pharmacy.controller';
import { PharmacyScheduler } from './pharmacy.scheduler';
import { PharmacyBatch, PharmacyBatchSchema } from './schemas/pharmacy-batch.schema';
import { PharmacyLine, PharmacyLineSchema } from './schemas/pharmacy-line.schema';
import { PharmacyLocation, PharmacyLocationSchema } from './schemas/pharmacy-location.schema';
import { PharmacyMovement, PharmacyMovementSchema } from './schemas/pharmacy-movement.schema';
import { PharmacyOrder, PharmacyOrderSchema } from './schemas/pharmacy-order.schema';
import { PharmacySnapshot, PharmacySnapshotSchema } from './schemas/pharmacy-snapshot.schema';
import { PharmacyStockLevel, PharmacyStockLevelSchema } from './schemas/pharmacy-stock-level.schema';

/**
 * The Pharmacy agent. It talks to the other agents only through the Coordinator, so PrescriptionsModule, LabModule,
 * ErModule and BedsModule are not imported. The Prescription model is registered here (Mongoose reuses an existing
 * model) for the prescription flow of the next task. PharmacyQueries is not a provider: PharmacyChecksService builds it.
 * Task 10 adds its own prescription service to this module and exports that one; the checks and orders services are
 * used only inside the module, so nothing is exported yet.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PharmacyOrder.name, schema: PharmacyOrderSchema },
      { name: PharmacyLine.name, schema: PharmacyLineSchema },
      { name: PharmacyLocation.name, schema: PharmacyLocationSchema },
      { name: PharmacyBatch.name, schema: PharmacyBatchSchema },
      { name: PharmacyMovement.name, schema: PharmacyMovementSchema },
      { name: PharmacyStockLevel.name, schema: PharmacyStockLevelSchema },
      { name: PharmacySnapshot.name, schema: PharmacySnapshotSchema },
      { name: Prescription.name, schema: PrescriptionSchema },
    ]),
    CoordinatorModule, // registry, messages, cases, and the Clock, counter and message models
    PatientsModule, // the patient service and model
    LabReportsModule, // the report model
    TasksAlertsModule, // the alert model
    AiModule,
    SettingsModule,
  ],
  controllers: [PharmacyController],
  providers: [
    PharmacySettingsService,
    PharmacyPatientsService,
    PharmacyOrdersService,
    PharmacyChecksService,
    PharmacyIssueService,
    PharmacyStockService,
    PharmacyReconcileService,
    PharmacyOverviewService,
    PharmacyAiService,
    PharmacyCoordinatorRegistration,
    PharmacyScheduler,
  ],
})
export class PharmacyModule {}
