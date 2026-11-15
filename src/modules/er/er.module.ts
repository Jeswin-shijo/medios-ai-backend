import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiModule } from '../ai/ai.module';
import { CoordinatorModule } from '../coordinator/coordinator.module';
import { PatientsModule } from '../patients/patients.module';
import { QueueModule } from '../queue/queue.module';
import { SettingsModule } from '../settings/settings.module';
import { VitalsModule } from '../vitals/vitals.module';
import { ErAiService } from './er-ai';
import { ErBaysService } from './er-bays.service';
import { ErCoordinatorRegistration } from './er-coordinator.registration';
import { ErController } from './er.controller';
import { ErOverviewService } from './er-overview.service';
import { ErScheduler } from './er.scheduler';
import { ErTargetsService } from './er-targets.service';
import { ErTriageService } from './er-triage.service';
import { ErVisitsService } from './er-visits.service';
import { ErBay, ErBaySchema } from './schemas/er-bay.schema';
import { ErExpected, ErExpectedSchema } from './schemas/er-expected.schema';
import { ErSnapshot, ErSnapshotSchema } from './schemas/er-snapshot.schema';
import { ErVisit, ErVisitSchema } from './schemas/er-visit.schema';

/** The ER agent. It talks to the other agents only through the Coordinator, so BedsModule is not imported. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ErVisit.name, schema: ErVisitSchema },
      { name: ErExpected.name, schema: ErExpectedSchema },
      { name: ErBay.name, schema: ErBaySchema },
      { name: ErSnapshot.name, schema: ErSnapshotSchema },
    ]),
    CoordinatorModule, // registry, messages, cases, rules and the Clock model
    PatientsModule, // the patient service and model
    VitalsModule, // the vitals service and model
    QueueModule, // NFC card lookup
    AiModule,
    SettingsModule,
  ],
  controllers: [ErController],
  exports: [ErVisitsService],
  providers: [ErVisitsService, ErTriageService, ErBaysService, ErTargetsService, ErOverviewService, ErAiService, ErCoordinatorRegistration, ErScheduler],
})
export class ErModule {}
