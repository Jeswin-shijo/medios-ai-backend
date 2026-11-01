import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppointmentsModule } from '../appointments/appointments.module';
import { CoordinatorModule } from '../coordinator/coordinator.module';
import { OpdModule } from '../opd/opd.module';
import { PatientsModule } from '../patients/patients.module';
import { SettingsModule } from '../settings/settings.module';
import { SchedulingCoordinatorRegistration } from './scheduling-coordinator.registration';
import { SchedulingAppointmentsService } from './scheduling-appointments.service';
import { SchedulingDoctorsService } from './scheduling-doctors.service';
import { SchedulingRosterService } from './scheduling-roster.service';
import { SchedulingSettingsService } from './scheduling-settings.service';
import { ConsultRequest, ConsultRequestSchema } from './schemas/consult-request.schema';
import { DoctorProfile, DoctorProfileSchema } from './schemas/doctor-profile.schema';
import { ProcedureBooking, ProcedureBookingSchema } from './schemas/procedure-booking.schema';
import { RosterEntry, RosterEntrySchema } from './schemas/roster-entry.schema';
import { RoomBlock, RoomBlockSchema } from './schemas/room-block.schema';
import { SchedulingSnapshot, SchedulingSnapshotSchema } from './schemas/scheduling-snapshot.schema';
import { StaffMember, StaffMemberSchema } from './schemas/staff-member.schema';
import { WaitItem, WaitItemSchema } from './schemas/wait-item.schema';

/**
 * The Scheduling agent. It talks to the other agents only through the Coordinator. Later tasks add their services,
 * the controller and the scheduler here.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: StaffMember.name, schema: StaffMemberSchema },
      { name: RosterEntry.name, schema: RosterEntrySchema },
      { name: DoctorProfile.name, schema: DoctorProfileSchema },
      { name: RoomBlock.name, schema: RoomBlockSchema },
      { name: ProcedureBooking.name, schema: ProcedureBookingSchema },
      { name: ConsultRequest.name, schema: ConsultRequestSchema },
      { name: WaitItem.name, schema: WaitItemSchema },
      { name: SchedulingSnapshot.name, schema: SchedulingSnapshotSchema },
    ]),
    CoordinatorModule, // registry, messages, cases, escalations, and the Clock model
    SettingsModule,
    OpdModule,
    AppointmentsModule,
    PatientsModule,
  ],
  providers: [SchedulingSettingsService, SchedulingRosterService, SchedulingCoordinatorRegistration, SchedulingDoctorsService, SchedulingAppointmentsService],
  exports: [SchedulingSettingsService, SchedulingRosterService, SchedulingDoctorsService, SchedulingAppointmentsService],
})
export class SchedulingModule {}
