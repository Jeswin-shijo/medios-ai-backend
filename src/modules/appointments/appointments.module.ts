import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Appointment, AppointmentSchema } from './schemas/appointment.schema';
import { AppointmentsService } from './appointments.service';
import { AppointmentsController } from './appointments.controller';
import { OpdModule } from '../opd/opd.module';
import { AppointmentEvents } from './appointment-events';

@Module({
  imports: [
    OpdModule,
    MongooseModule.forFeature([
      { name: Appointment.name, schema: AppointmentSchema },
    ]),
  ],
  controllers: [AppointmentsController],
  providers: [AppointmentsService, AppointmentEvents],
  exports: [AppointmentsService, AppointmentEvents, MongooseModule],
})
export class AppointmentsModule {}
