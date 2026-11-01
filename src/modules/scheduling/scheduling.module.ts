import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiModule } from '../ai/ai.module';
import { AppointmentsModule } from '../appointments/appointments.module';
import { CoordinatorModule } from '../coordinator/coordinator.module';
import { FollowUpsModule } from '../follow-ups/follow-ups.module';
import { Department, DepartmentSchema } from '../opd/schemas/department.schema';
import { OpdModule } from '../opd/opd.module';
import { PatientsModule } from '../patients/patients.module';
import { SettingsModule } from '../settings/settings.module';
import { TasksAlertsModule } from '../tasks-alerts/tasks-alerts.module';
import { SchedulingCoordinatorRegistration } from './scheduling-coordinator.registration';
import { SchedulingAppointmentsService } from './scheduling-appointments.service';
import { SchedulingConflictsService } from './scheduling-conflicts.service';
import { SchedulingConsultsService } from './scheduling-consults.service';
import { SchedulingFollowupsService } from './scheduling-followups.service';
import { SchedulingWaitlistService } from './scheduling-waitlist.service';
import { SchedulingDoctorsService } from './scheduling-doctors.service';
import { SchedulingAiService } from './scheduling-ai';
import { SchedulingOverviewService } from './scheduling-overview.service';
import { SchedulingProceduresService } from './scheduling-procedures.service';
import { SchedulingReconcileService } from './scheduling-reconcile.service';
import { SchedulingRosterService } from './scheduling-roster.service';
import { SchedulingSettingsService } from './scheduling-settings.service';
import { ConsultRequest, ConsultRequestSchema } from './schemas/consult-request.schema';
import { DoctorProfile, DoctorProfileSchema } from './schemas/doctor-profile.schema';
import { ProcedureBooking, ProcedureBookingSchema } from './schemas/procedure-booking.schema';
import { RosterEntry, RosterEntrySchema } from './schemas/roster-entry.schema';
import { RoomBlock, RoomBlockSchema } from './schemas/room-block.schema';
import { SchedulingLock, SchedulingLockSchema } from './schemas/scheduling-lock.schema';
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
      { name: Department.name, schema: DepartmentSchema },
      { name: StaffMember.name, schema: StaffMemberSchema },
      { name: RosterEntry.name, schema: RosterEntrySchema },
      { name: DoctorProfile.name, schema: DoctorProfileSchema },
      { name: RoomBlock.name, schema: RoomBlockSchema },
      { name: ProcedureBooking.name, schema: ProcedureBookingSchema },
      { name: ConsultRequest.name, schema: ConsultRequestSchema },
      { name: WaitItem.name, schema: WaitItemSchema },
      { name: SchedulingSnapshot.name, schema: SchedulingSnapshotSchema },
      { name: SchedulingLock.name, schema: SchedulingLockSchema },
    ]),
    CoordinatorModule, // registry, messages, cases, escalations, and the Clock model
    SettingsModule,
    AiModule,
    OpdModule,
    AppointmentsModule,
    PatientsModule,
    FollowUpsModule,
    TasksAlertsModule, // the alert model
  ],
  providers: [
    SchedulingSettingsService,
    SchedulingRosterService,
    SchedulingCoordinatorRegistration,
    SchedulingDoctorsService,
    SchedulingAppointmentsService,
    SchedulingProceduresService,
    SchedulingWaitlistService,
    SchedulingFollowupsService,
    SchedulingConsultsService,
    SchedulingConflictsService,
    SchedulingReconcileService,
    SchedulingAiService,
    SchedulingOverviewService,
  ],
  exports: [SchedulingSettingsService, SchedulingRosterService, SchedulingDoctorsService, SchedulingAppointmentsService, SchedulingProceduresService, SchedulingWaitlistService, SchedulingFollowupsService, SchedulingConsultsService, SchedulingConflictsService, SchedulingReconcileService, SchedulingOverviewService],
})
export class SchedulingModule {}
