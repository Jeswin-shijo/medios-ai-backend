import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { apiJsonPlugin } from './common/database/api-json.plugin';

import { UsersModule } from './modules/users/users.module';
import { AuthModule } from './modules/auth/auth.module';
import { PatientsModule } from './modules/patients/patients.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { ConsultationsModule } from './modules/consultations/consultations.module';
import { PrescriptionsModule } from './modules/prescriptions/prescriptions.module';
import { MedicationsModule } from './modules/medications/medications.module';
import { LabReportsModule } from './modules/lab-reports/lab-reports.module';
import { ImagingModule } from './modules/imaging/imaging.module';
import { BillingModule } from './modules/billing/billing.module';
import { FollowUpsModule } from './modules/follow-ups/follow-ups.module';
import { TimelineModule } from './modules/timeline/timeline.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { VitalsModule } from './modules/vitals/vitals.module';
import { TasksAlertsModule } from './modules/tasks-alerts/tasks-alerts.module';
import { MessagesModule } from './modules/messages/messages.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { VoiceToNotesModule } from './modules/voice-to-notes/voice-to-notes.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { SettingsModule } from './modules/settings/settings.module';
import { CallsModule } from './modules/calls/calls.module';
import { QueueModule } from './modules/queue/queue.module';
import { AiModule } from './modules/ai/ai.module';
import { BedsModule } from './modules/beds/beds.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    // Per-client request budget; auth endpoints set tighter limits with @Throttle.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>('database.uri'),
        connectionFactory: (connection) => {
          connection.plugin(apiJsonPlugin);
          return connection;
        },
      }),
      inject: [ConfigService],
    }),
    UsersModule,
    AuthModule,
    PatientsModule,
    AppointmentsModule,
    ConsultationsModule,
    PrescriptionsModule,
    MedicationsModule,
    LabReportsModule,
    ImagingModule,
    BillingModule,
    FollowUpsModule,
    TimelineModule,
    DocumentsModule,
    VitalsModule,
    TasksAlertsModule,
    MessagesModule,
    KnowledgeModule,
    VoiceToNotesModule,
    DashboardModule,
    SettingsModule,
    CallsModule,
    QueueModule,
    AiModule,
    BedsModule,
  ],
  controllers: [HealthController],
  // Guards run in this order: rate limit, then authentication, then role checks.
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TransformInterceptor,
    },
  ],
})
export class AppModule {}
