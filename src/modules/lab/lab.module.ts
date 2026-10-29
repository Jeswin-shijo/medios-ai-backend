import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiModule } from '../ai/ai.module';
import { CoordinatorModule } from '../coordinator/coordinator.module';
import { LabReportsModule } from '../lab-reports/lab-reports.module';
import { PatientsModule } from '../patients/patients.module';
import { SettingsModule } from '../settings/settings.module';
import { TasksAlertsModule } from '../tasks-alerts/tasks-alerts.module';
import { LabAiService } from './lab-ai';
import { LabBenchService } from './lab-bench.service';
import { LabCoordinatorRegistration } from './lab-coordinator.registration';
import { LabOrdersService } from './lab-orders.service';
import { LabOverviewService } from './lab-overview.service';
import { LabResultsService } from './lab-results.service';
import { LabSettingsService } from './lab-settings.service';
import { LabController } from './lab.controller';
import { LabScheduler } from './lab.scheduler';
import { LabLine, LabLineSchema } from './schemas/lab-line.schema';
import { LabLocation, LabLocationSchema } from './schemas/lab-location.schema';
import { LabRequest, LabRequestSchema } from './schemas/lab-request.schema';
import { LabSample, LabSampleSchema } from './schemas/lab-sample.schema';
import { LabSnapshot, LabSnapshotSchema } from './schemas/lab-snapshot.schema';

/** The Lab agent. It talks to the other agents only through the Coordinator, so BedsModule and ErModule are not imported. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LabRequest.name, schema: LabRequestSchema },
      { name: LabLine.name, schema: LabLineSchema },
      { name: LabSample.name, schema: LabSampleSchema },
      { name: LabLocation.name, schema: LabLocationSchema },
      { name: LabSnapshot.name, schema: LabSnapshotSchema },
    ]),
    CoordinatorModule, // registry, messages, cases, rules, and the Clock and counter models
    PatientsModule, // the patient service and model
    LabReportsModule, // the report model
    TasksAlertsModule, // the alert model
    AiModule,
    SettingsModule,
  ],
  controllers: [LabController],
  providers: [
    LabSettingsService,
    LabOrdersService,
    LabBenchService,
    LabResultsService,
    LabOverviewService,
    LabAiService,
    LabCoordinatorRegistration,
    LabScheduler,
  ],
})
export class LabModule {}
