import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppointmentSchema, Appointment } from '../appointments/schemas/appointment.schema';
import { AiModule } from '../ai/ai.module';
import { Admission, AdmissionSchema } from '../beds/schemas/admission.schema';
import { Bed, BedSchema } from '../beds/schemas/bed.schema';
import { Ward, WardSchema } from '../beds/schemas/ward.schema';
import { AgentCall, AgentCallSchema } from '../calls/schemas/agent-call.schema';
import { CallsModule } from '../calls/calls.module';
import { CoordinatorModule } from '../coordinator/coordinator.module';
import { AgentMessage, AgentMessageSchema } from '../coordinator/schemas/agent-message.schema';
import { Case, CaseSchema } from '../coordinator/schemas/case.schema';
import { CoordinatorCounter, CoordinatorCounterSchema } from '../coordinator/schemas/coordinator-counter.schema';
import { DischargeOrder, DischargeOrderSchema } from '../discharge/schemas/discharge-order.schema';
import { DischargePlan, DischargePlanSchema } from '../discharge/schemas/discharge-plan.schema';
import { ErModule } from '../er/er.module';
import { ErVisit, ErVisitSchema } from '../er/schemas/er-visit.schema';
import { FollowUpItem, FollowUpItemSchema } from '../follow-ups/schemas/follow-up.schema';
import { PatientsModule } from '../patients/patients.module';
import { Patient, PatientSchema } from '../patients/schemas/patient.schema';
import { Bill, BillSchema } from '../revenue/schemas/bill.schema';
import { Estimate, EstimateSchema } from '../revenue/schemas/estimate.schema';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { ProcedureBooking, ProcedureBookingSchema } from '../scheduling/schemas/procedure-booking.schema';
import { SettingsModule } from '../settings/settings.module';
import { TaskAlertItem, TaskAlertItemSchema } from '../tasks-alerts/schemas/task-alert.schema';
import { TimelineModule } from '../timeline/timeline.module';
import { SupportBridgeRegistration } from './support-bridge.registration';
import { SupportAiService } from './support-ai';
import { SupportRegistration } from './support-coordinator.registration';
import { SupportCheckupsService } from './support-checkups.service';
import { SupportFactsService } from './support-facts.service';
import { SupportFeedbackService } from './support-feedback.service';
import { SupportOverviewService } from './support-overview.service';
import { SupportSettingsService } from './support-settings.service';
import { MESSAGE_SENDER, createMessageSender } from './support-sender';
import { SupportTextsService } from './support-texts.service';
import { SupportTicketsService } from './support-tickets.service';
import { SupportUpdatesService } from './support-updates.service';
import { SupportController } from './support.controller';
import { SupportScheduler } from './support.scheduler';
import { CheckupCall, CheckupCallSchema } from './schemas/checkup-call.schema';
import { PatientUpdate, PatientUpdateSchema } from './schemas/patient-update.schema';
import { SupportFaq, SupportFaqSchema } from './schemas/support-faq.schema';
import { SupportFeedback, SupportFeedbackSchema } from './schemas/support-feedback.schema';
import { SupportTemplate, SupportTemplateSchema } from './schemas/support-template.schema';
import { SupportTicket, SupportTicketSchema } from './schemas/support-ticket.schema';

/**
 * The Patient Support agent. It reads the other agents' records through its own models and changes nothing of theirs
 * except through the services they export (the ER for an expected arrival, Calls for the check-up dial, the Coordinator
 * for cases, messages and escalations). Calls reaches it only through the global `SupportBridge`, and nothing imports
 * this module, so no module cycle forms.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SupportTicket.name, schema: SupportTicketSchema },
      { name: PatientUpdate.name, schema: PatientUpdateSchema },
      { name: CheckupCall.name, schema: CheckupCallSchema },
      { name: SupportFeedback.name, schema: SupportFeedbackSchema },
      { name: SupportTemplate.name, schema: SupportTemplateSchema },
      { name: SupportFaq.name, schema: SupportFaqSchema },
      // Other agents' records, read-only.
      { name: Patient.name, schema: PatientSchema },
      { name: Admission.name, schema: AdmissionSchema },
      { name: Bed.name, schema: BedSchema },
      { name: Ward.name, schema: WardSchema },
      { name: ProcedureBooking.name, schema: ProcedureBookingSchema },
      { name: FollowUpItem.name, schema: FollowUpItemSchema },
      { name: Appointment.name, schema: AppointmentSchema },
      { name: Bill.name, schema: BillSchema },
      { name: Estimate.name, schema: EstimateSchema },
      { name: DischargePlan.name, schema: DischargePlanSchema },
      { name: DischargeOrder.name, schema: DischargeOrderSchema },
      { name: ErVisit.name, schema: ErVisitSchema },
      { name: Case.name, schema: CaseSchema },
      { name: AgentCall.name, schema: AgentCallSchema },
      { name: TaskAlertItem.name, schema: TaskAlertItemSchema },
      { name: AgentMessage.name, schema: AgentMessageSchema },
      { name: CoordinatorCounter.name, schema: CoordinatorCounterSchema }
    ]),
    SettingsModule,
    CoordinatorModule, // registry, messages, cases, rules, escalations
    PatientsModule,
    TimelineModule,
    AiModule,
    ErModule, // ErVisitsService (an expected arrival)
    SchedulingModule, // SchedulingRosterService (who is on duty)
    CallsModule // CallsService (the check-up dial)
  ],
  controllers: [SupportController],
  providers: [
    // Null when MESSAGE_PROVIDER=none: updates are then skipped as "messaging off".
    {
      provide: MESSAGE_SENDER,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => createMessageSender(c.get<string>('support.messageProvider') ?? 'none')
    },
    SupportSettingsService,
    SupportRegistration,
    SupportTextsService,
    SupportFactsService,
    SupportUpdatesService,
    SupportTicketsService,
    SupportFeedbackService,
    SupportCheckupsService,
    SupportAiService,
    SupportOverviewService,
    SupportBridgeRegistration,
    SupportScheduler
  ],
  exports: [
    SupportTicketsService,
    SupportUpdatesService,
    SupportCheckupsService,
    SupportFactsService,
    SupportTextsService,
    SupportSettingsService,
    SupportOverviewService
  ]
})
export class PatientSupportModule implements OnModuleInit {
  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    if (this.config.get<boolean>('isProduction') && this.config.get<string>('support.messageProvider') === 'sample') {
      new Logger('PatientSupport').warn('SAMPLE family messages are on in production: nothing is sent, and screens say SAMPLE. Never use with real patients.');
    }
  }
}
