import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Ward, WardSchema } from './schemas/ward.schema';
import { Bed, BedSchema } from './schemas/bed.schema';
import { Admission, AdmissionSchema } from './schemas/admission.schema';
import { BedSuggestion, BedSuggestionSchema } from './schemas/bed-suggestion.schema';
import { BedsController } from './beds.controller';
import { BedsService } from './beds.service';
import { SuggestionsService } from './suggestions.service';
import { BedEvents } from './bed-events';
import { AiModule } from '../ai/ai.module';
import { PatientsModule } from '../patients/patients.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Ward.name, schema: WardSchema },
      { name: Bed.name, schema: BedSchema },
      { name: Admission.name, schema: AdmissionSchema },
      { name: BedSuggestion.name, schema: BedSuggestionSchema },
    ]),
    AiModule,
    PatientsModule,
  ],
  controllers: [BedsController],
  providers: [BedsService, SuggestionsService, BedEvents],
  exports: [BedsService],
})
export class BedsModule {}
