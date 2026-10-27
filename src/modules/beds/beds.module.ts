import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Ward, WardSchema } from './schemas/ward.schema';
import { Bed, BedSchema } from './schemas/bed.schema';
import { Admission, AdmissionSchema } from './schemas/admission.schema';
import { BedSuggestion, BedSuggestionSchema } from './schemas/bed-suggestion.schema';
import { BedsController } from './beds.controller';
import { BedRequestsController } from './bed-requests.controller';
import { BedAgentService } from './bed-agent.service';
import { BedAgentScheduler } from './bed-agent.scheduler';
import { SettingsModule } from '../settings/settings.module';
import { BedsService } from './beds.service';
import { SuggestionsService } from './suggestions.service';
import { BedEvents } from './bed-events';
import { BedAlerts } from './bed-alerts';
import { BedRequestsService } from './bed-requests.service';
import { BedRequest, BedRequestSchema } from './schemas/bed-request.schema';
import { TasksAlertsModule } from '../tasks-alerts/tasks-alerts.module';
import { AiModule } from '../ai/ai.module';
import { PatientsModule } from '../patients/patients.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Ward.name, schema: WardSchema },
      { name: Bed.name, schema: BedSchema },
      { name: Admission.name, schema: AdmissionSchema },
      { name: BedSuggestion.name, schema: BedSuggestionSchema },
      { name: BedRequest.name, schema: BedRequestSchema },
    ]),
    AiModule,
    PatientsModule,
    TasksAlertsModule,
    SettingsModule,
  ],
  controllers: [BedRequestsController, BedsController],
  providers: [BedsService, SuggestionsService, BedEvents, BedAlerts, BedRequestsService, BedAgentService, BedAgentScheduler],
  exports: [BedsService],
})
export class BedsModule {}
