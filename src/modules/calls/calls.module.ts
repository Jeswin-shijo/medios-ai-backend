import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AgentCall, AgentCallSchema } from './schemas/agent-call.schema';
import { InboundSession, InboundSessionSchema } from './schemas/inbound-session.schema';
import { CallerLookup, CallerLookupSchema } from './schemas/caller-lookup.schema';
import { InboundService } from './inbound.service';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';
import { CallSchedulerService } from './call-scheduler.service';
import { SlotsService } from './slots.service';
import { NoCallProvider, VOICE_PROVIDER, VoiceProvider } from './providers/voice-provider';
import { SimulatedProvider } from './providers/simulated.provider';
import { SnapServeConfig, SnapServeProvider } from './providers/snapserve.provider';
import { AppointmentsModule } from '../appointments/appointments.module';
import { PatientsModule } from '../patients/patients.module';
import { FollowUpsModule } from '../follow-ups/follow-ups.module';
import { TasksAlertsModule } from '../tasks-alerts/tasks-alerts.module';
import { SettingsModule } from '../settings/settings.module';
import { OpdModule } from '../opd/opd.module';
import { SchedulingModule } from '../scheduling/scheduling.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AgentCall.name, schema: AgentCallSchema },
      { name: InboundSession.name, schema: InboundSessionSchema },
      { name: CallerLookup.name, schema: CallerLookupSchema },
    ]),
    AppointmentsModule,
    PatientsModule,
    FollowUpsModule,
    TasksAlertsModule,
    SettingsModule,
    OpdModule,
    SchedulingModule,
  ],
  controllers: [CallsController],
  providers: [
    CallsService,
    InboundService,
    CallSchedulerService,
    SlotsService,
    {
      // CALL_PROVIDER picks who runs the conversation; validated at startup (env.validation.ts).
      provide: VOICE_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): VoiceProvider => {
        switch (config.get<string>('callAgent.provider')) {
          case 'snapserve':
            return new SnapServeProvider(config.get<SnapServeConfig>('callAgent.snapserve'));
          case 'simulated':
            return new SimulatedProvider(config.get<number>('callAgent.simulatedDelayMs'));
          default:
            return new NoCallProvider();
        }
      },
    },
  ],
})
export class CallsModule {}
