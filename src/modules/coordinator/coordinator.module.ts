import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiModule } from '../ai/ai.module';
import { PatientsModule } from '../patients/patients.module';
import { SettingsModule } from '../settings/settings.module';
import { TasksAlertsModule } from '../tasks-alerts/tasks-alerts.module';
import { TimelineModule } from '../timeline/timeline.module';
import { UsersModule } from '../users/users.module';
import { User, UserSchema } from '../users/schemas/user.schema';
import { AgentMessage, AgentMessageSchema } from './schemas/agent-message.schema';
import { Approval, ApprovalSchema } from './schemas/approval.schema';
import { Case, CaseSchema } from './schemas/case.schema';
import { ChatLog, ChatLogSchema } from './schemas/chat-log.schema';
import { Clock, ClockSchema } from './schemas/clock.schema';
import { CoordinatorCounter, CoordinatorCounterSchema } from './schemas/coordinator-counter.schema';
import { CoordinatorSnapshot, CoordinatorSnapshotSchema } from './schemas/coordinator-snapshot.schema';
import { DutyTitle, DutyTitleSchema } from './schemas/duty-title.schema';
import { Escalation, EscalationSchema } from './schemas/escalation.schema';
import { Ladder, LadderSchema } from './schemas/ladder.schema';
import { AgentRegistry } from './agent-registry';
import { AgentStatusService } from './agent-status.service';
import { ApprovalsService } from './approvals.service';
import { CasesService } from './cases.service';
import { ChatService } from './chat.service';
import { ClocksService } from './clocks.service';
import { CoordinatorController } from './coordinator.controller';
import { CoordinatorEvents } from './coordinator-events';
import { CoordinatorOverviewService } from './coordinator-overview.service';
import { CoordinatorScheduler } from './coordinator.scheduler';
import { EscalationsService } from './escalations.service';
import { MessagesService } from './messages.service';
import { RulesService } from './rules.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AgentMessage.name, schema: AgentMessageSchema },
      { name: Approval.name, schema: ApprovalSchema },
      { name: Case.name, schema: CaseSchema },
      { name: ChatLog.name, schema: ChatLogSchema },
      { name: Clock.name, schema: ClockSchema },
      { name: CoordinatorCounter.name, schema: CoordinatorCounterSchema },
      { name: CoordinatorSnapshot.name, schema: CoordinatorSnapshotSchema },
      { name: DutyTitle.name, schema: DutyTitleSchema },
      { name: Escalation.name, schema: EscalationSchema },
      { name: Ladder.name, schema: LadderSchema },
      { name: User.name, schema: UserSchema },
    ]),
    AiModule,
    PatientsModule,
    SettingsModule,
    TasksAlertsModule, // the alert model and service
    TimelineModule,
    UsersModule,
  ],
  controllers: [CoordinatorController],
  providers: [
    AgentRegistry,
    CoordinatorEvents,
    MessagesService,
    CasesService,
    EscalationsService,
    ClocksService,
    ApprovalsService,
    RulesService,
    AgentStatusService,
    CoordinatorOverviewService,
    ChatService,
    CoordinatorScheduler,
  ],
  exports: [AgentRegistry, MessagesService, CasesService, ApprovalsService, CoordinatorEvents, RulesService, MongooseModule],
})
export class CoordinatorModule {}
