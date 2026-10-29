import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QueueToken, QueueTokenSchema } from './schemas/queue-token.schema';
import { QueueSequence, QueueSequenceSchema } from './schemas/queue-sequence.schema';
import { QueueDisplay, QueueDisplaySchema } from './schemas/queue-display.schema';
import { PatientCard, PatientCardSchema } from './schemas/patient-card.schema';
import { QueueController } from './queue.controller';
import { QueueService } from './queue.service';
import { QueueDisplaysService } from './queue-displays.service';
import { QueueEvents } from './queue-events';
import { PatientCardsService } from './patient-cards.service';
import { AppointmentsModule } from '../appointments/appointments.module';
import { PatientsModule } from '../patients/patients.module';
import { OpdModule } from '../opd/opd.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: QueueToken.name, schema: QueueTokenSchema },
      { name: QueueSequence.name, schema: QueueSequenceSchema },
      { name: QueueDisplay.name, schema: QueueDisplaySchema },
      { name: PatientCard.name, schema: PatientCardSchema },
    ]),
    AppointmentsModule,
    PatientsModule,
    SettingsModule,
    OpdModule,
  ],
  controllers: [QueueController],
  providers: [QueueService, QueueDisplaysService, PatientCardsService, QueueEvents],
  exports: [QueueService],
})
export class QueueModule {}
