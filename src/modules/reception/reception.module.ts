import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppointmentsModule } from '../appointments/appointments.module';
import { OpdModule } from '../opd/opd.module';
import { PatientsModule } from '../patients/patients.module';
import { QueueModule } from '../queue/queue.module';
import { RevenueModule } from '../revenue/revenue.module';
import { SettingsModule } from '../settings/settings.module';
import { ReceptionIdentityService } from './identity.service';
import { KioskController } from './kiosk.controller';
import { PAYMENT_PROVIDER, createPaymentProvider } from './providers/payment-provider';
import { SMS_PROVIDER, createSmsProvider } from './providers/sms-provider';
import { ReceptionController } from './reception.controller';
import { OpSequence, OpSequenceSchema } from './schemas/op-sequence.schema';
import { OpVisit, OpVisitSchema } from './schemas/op-visit.schema';
import { OtpChallenge, OtpChallengeSchema } from './schemas/otp-challenge.schema';
import { ReceptionSession, ReceptionSessionSchema } from './schemas/reception-session.schema';
import { OpVisitsService } from './visits.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OpVisit.name, schema: OpVisitSchema },
      { name: OpSequence.name, schema: OpSequenceSchema },
      { name: ReceptionSession.name, schema: ReceptionSessionSchema },
      { name: OtpChallenge.name, schema: OtpChallengeSchema },
    ]),
    PatientsModule,
    AppointmentsModule,
    OpdModule,
    QueueModule,
    // Kiosk payments are Revenue payments (R26). Revenue imports nothing of the kiosk, so there is no cycle.
    RevenueModule,
    SettingsModule,
  ],
  controllers: [KioskController, ReceptionController],
  providers: [
    ReceptionIdentityService,
    OpVisitsService,
    // Without these the services run cash-only and without "find by phone".
    { provide: SMS_PROVIDER, inject: [ConfigService], useFactory: (c: ConfigService) => createSmsProvider(c.get<string>('reception.smsProvider') ?? 'none') },
    { provide: PAYMENT_PROVIDER, inject: [ConfigService], useFactory: (c: ConfigService) => createPaymentProvider(c.get<string>('reception.paymentProvider') ?? 'none') },
  ],
})
export class ReceptionModule implements OnModuleInit {
  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const sample = this.config.get<string>('reception.smsProvider') === 'sample' || this.config.get<string>('reception.paymentProvider') === 'sample';
    if (this.config.get<boolean>('isProduction') && sample) {
      new Logger('Reception').warn(
        'SAMPLE payments/SMS are on in production: OTP codes show on the kiosk and payments are simulated. Never use with real patients.',
      );
    }
  }
}
