import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Ward, WardSchema } from './schemas/ward.schema';
import { Bed, BedSchema } from './schemas/bed.schema';
import { Admission, AdmissionSchema } from './schemas/admission.schema';
import { BedSuggestion, BedSuggestionSchema } from './schemas/bed-suggestion.schema';
import { BedsController } from './beds.controller';
import { BedOverviewController, BedRequestsController } from './bed-requests.controller';
import { BedAgentService } from './bed-agent.service';
import { BedAgentScheduler } from './bed-agent.scheduler';
import { SettingsModule } from '../settings/settings.module';
import { BedsService } from './beds.service';
import { SuggestionsService } from './suggestions.service';
import { BedEvents } from './bed-events';
import { BedAlerts } from './bed-alerts';
import { BedRequestsService } from './bed-requests.service';
import { BedOverviewService } from './bed-overview.service';
import { BedSnapshot, BedSnapshotSchema } from './schemas/bed-snapshot.schema';
import { BedRequest, BedRequestSchema } from './schemas/bed-request.schema';
import { TasksAlertsModule } from '../tasks-alerts/tasks-alerts.module';
import { AiModule } from '../ai/ai.module';
import { CoordinatorModule } from '../coordinator/coordinator.module';
import { BedCoordinatorBridge } from './bed-coordinator.bridge';
import { PatientsModule } from '../patients/patients.module';
import { DischargeOrder, DischargeOrderSchema } from '../discharge/schemas/discharge-order.schema';
import { DischargePlan, DischargePlanSchema } from '../discharge/schemas/discharge-plan.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Ward.name, schema: WardSchema },
      { name: Bed.name, schema: BedSchema },
      { name: Admission.name, schema: AdmissionSchema },
      { name: BedSuggestion.name, schema: BedSuggestionSchema },
      { name: BedRequest.name, schema: BedRequestSchema },
      { name: BedSnapshot.name, schema: BedSnapshotSchema },
      // Read only: "Leaving soon" and the discharge planning dates. The Discharge Agent writes them.
      { name: DischargeOrder.name, schema: DischargeOrderSchema },
      { name: DischargePlan.name, schema: DischargePlanSchema },
    ]),
    AiModule,
    PatientsModule,
    TasksAlertsModule,
    SettingsModule,
    CoordinatorModule,
  ],
  controllers: [BedRequestsController, BedOverviewController, BedsController],
  providers: [BedsService, SuggestionsService, BedEvents, BedAlerts, BedRequestsService, BedAgentService, BedAgentScheduler, BedOverviewService, BedCoordinatorBridge],
  exports: [BedsService],
})
export class BedsModule {}
