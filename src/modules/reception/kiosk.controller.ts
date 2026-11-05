import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { clinicNow, isoDate } from '../../common/utils/clinic-time';
import { Availability, doctorAvailability } from '../opd/availability';
import { OpdService } from '../opd/opd.service';
import { QueueDisplaysService } from '../queue/queue-displays.service';
import { QueueService } from '../queue/queue.service';
import { SettingsService } from '../settings/settings.service';
import { CardDto, CreateVisitDto, DoctorsQueryDto, PayDto, RegisterDto, SendOtpDto, VerifyOtpDto } from './dto/reception.dto';
import { ReceptionIdentityService } from './identity.service';
import { ReceptionSettings, resolveReceptionSettings } from './reception-settings';
import { KioskRef } from './reception.types';
import { resolveTrackingBase } from './token-view';
import { OpVisitsService } from './visits.service';

const MINUTE = 60_000;

export interface KioskConfig {
  kioskName: string;
  hospital: { name: string; address: string; phone: string };
  printSlips: boolean;
  /** A method is on when the setting allows it and (for UPI and card) a payment provider exists. */
  methods: { upi: boolean; cash: boolean; card: boolean };
  /** Sample mode: the screens must say SAMPLE. */
  sample: { payments: boolean; sms: boolean };
  /** Finding a record by mobile number needs an SMS provider. */
  findByPhone: boolean;
  idleSeconds: number;
  slipFooter: string;
  trackingBaseUrl: string;
  clinic: { date: string; utcOffsetMinutes: number; serverTime: string };
}

export interface KioskConfigInput {
  kioskName: string;
  printSlips: boolean;
  hospital: { name: string; address: string; phone: string };
  reception: ReceptionSettings;
  /** 'sample' or 'none'. */
  paymentProvider: string;
  smsProvider: string;
  publicWebUrl: string;
  now: Date;
}

export function buildKioskConfig(i: KioskConfigInput): KioskConfig {
  const payments = i.paymentProvider !== 'none';
  const clinic = clinicNow(i.now);
  return {
    kioskName: i.kioskName,
    hospital: i.hospital,
    printSlips: i.printSlips,
    methods: { upi: payments && i.reception.methods.upi, cash: i.reception.methods.cash, card: payments && i.reception.methods.card },
    sample: { payments: i.paymentProvider === 'sample', sms: i.smsProvider === 'sample' },
    findByPhone: i.smsProvider !== 'none',
    idleSeconds: i.reception.idleSeconds,
    slipFooter: i.reception.slipFooter,
    trackingBaseUrl: resolveTrackingBase(i.reception, i.publicWebUrl),
    clinic: { date: isoDate(clinic), utcOffsetMinutes: -i.now.getTimezoneOffset(), serverTime: i.now.toISOString() },
  };
}

/** The tablet at the reception: a kiosk key identifies it, nobody signs in. */
@ApiTags('Reception Kiosk')
@ApiHeader({ name: 'Authorization', description: 'Kiosk <key>' })
@Public()
@Throttle({ default: { limit: 120, ttl: MINUTE } })
@Controller('reception/kiosk')
export class KioskController {
  constructor(
    private readonly displays: QueueDisplaysService,
    private readonly identity: ReceptionIdentityService,
    private readonly visits: OpVisitsService,
    private readonly opd: OpdService,
    private readonly queue: QueueService,
    private readonly settings: SettingsService,
    private readonly config: ConfigService,
  ) {}

  private async kiosk(authorization?: string): Promise<KioskRef & { printSlips: boolean }> {
    const device = await this.displays.authenticate(authorization, 'kiosk');
    return { id: String(device._id), name: device.name, printSlips: device.printSlips };
  }

  @Get('config')
  @ApiOperation({ summary: "The kiosk's settings: hospital, payment methods, sample flags, clinic day" })
  async getConfig(@Headers('authorization') authorization?: string): Promise<KioskConfig> {
    const kiosk = await this.kiosk(authorization);
    const s = (await this.settings.getSettings()) as unknown as Record<string, any>;
    return buildKioskConfig({
      kioskName: kiosk.name,
      printSlips: kiosk.printSlips,
      hospital: { name: String(s.hospital?.name ?? ''), address: String(s.hospital?.address ?? ''), phone: String(s.hospital?.phone ?? '') },
      reception: resolveReceptionSettings(s.reception),
      paymentProvider: this.config.get<string>('reception.paymentProvider') ?? 'none',
      smsProvider: this.config.get<string>('reception.smsProvider') ?? 'none',
      publicWebUrl: this.config.get<string>('reception.publicWebUrl') ?? '',
      now: new Date(),
    });
  }

  @Get('departments')
  @ApiOperation({ summary: 'Active departments with the number of active doctors' })
  async departments(@Headers('authorization') authorization?: string) {
    await this.kiosk(authorization);
    const [departments, doctors] = await Promise.all([this.opd.listDepartments({ activeOnly: true }), this.opd.listDoctors({ activeOnly: true })]);
    return departments.map((d) => ({
      code: d.code,
      name: d.name,
      icon: d.icon,
      color: d.color,
      doctorCount: doctors.filter((doc) => doc.departmentCode === d.code).length,
    }));
  }

  @Get('doctors')
  @ApiOperation({ summary: "Active doctors of a department with today's availability" })
  async doctors(@Headers('authorization') authorization: string | undefined, @Query() query: DoctorsQueryDto) {
    await this.kiosk(authorization);
    const [doctors, departments, waiting] = await Promise.all([
      this.opd.listDoctors({ activeOnly: true, departmentCode: query.department }),
      this.opd.listDepartments(),
      this.queue.waitingCountsBySeries(),
    ]);
    const names = new Map(departments.map((d) => [d.code, d.name]));
    const now = clinicNow();
    return doctors.map((d) => {
      const availability: Availability = doctorAvailability(d.sessions, now, waiting.get(String(d._id)) ?? 0, d.avgConsultMinutes);
      return {
        id: String(d._id),
        name: d.name,
        qualifications: d.qualifications,
        department: names.get(d.departmentCode) ?? d.departmentCode,
        departmentCode: d.departmentCode,
        fee: d.fee,
        room: d.room,
        availability,
      };
    });
  }

  @Post('identify/card')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'A card tap: who is this patient' })
  async identifyCard(@Headers('authorization') authorization: string | undefined, @Body() dto: CardDto) {
    return this.identity.identifyByCard(await this.kiosk(authorization), dto.cardId);
  }

  @Post('otp/send')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @ApiOperation({ summary: 'Send a code to a mobile number (the answer is the same for known and unknown numbers)' })
  async sendOtp(@Headers('authorization') authorization: string | undefined, @Body() dto: SendOtpDto) {
    return this.identity.sendOtp(await this.kiosk(authorization), dto.phone);
  }

  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check the code; returns the patients on that number' })
  async verifyOtp(@Headers('authorization') authorization: string | undefined, @Body() dto: VerifyOtpDto) {
    return this.identity.verifyOtp(await this.kiosk(authorization), dto.phone, dto.code);
  }

  @Post('register')
  @Throttle({ default: { limit: 20, ttl: MINUTE } })
  @ApiOperation({ summary: 'Register a new patient at the kiosk' })
  async register(@Headers('authorization') authorization: string | undefined, @Body() dto: RegisterDto) {
    return this.identity.register(await this.kiosk(authorization), dto);
  }

  @Post('visits')
  @ApiOperation({ summary: 'Start an OP visit with a doctor' })
  async createVisit(@Headers('authorization') authorization: string | undefined, @Body() dto: CreateVisitDto) {
    return this.visits.create(await this.kiosk(authorization), dto.session, dto.doctorId);
  }

  @Get('visits/:id')
  @ApiOperation({ summary: "This kiosk's visit; a paid one carries its OP number, token and bill" })
  async getVisit(@Headers('authorization') authorization: string | undefined, @Param('id') id: string) {
    return this.visits.getForKiosk(await this.kiosk(authorization), id);
  }

  @Post('visits/:id/pay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Choose how to pay (UPI, card or cash)' })
  async pay(@Headers('authorization') authorization: string | undefined, @Param('id') id: string, @Body() dto: PayDto) {
    return this.visits.pay(await this.kiosk(authorization), id, dto.method);
  }

  @Post('visits/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an unpaid visit (not a cash one)' })
  async cancel(@Headers('authorization') authorization: string | undefined, @Param('id') id: string) {
    const kiosk = await this.kiosk(authorization);
    return this.visits.cancel(id, { actor: `Kiosk: ${kiosk.name}`, kioskId: kiosk.id });
  }

  @Post('visits/:id/sample-complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sample mode only: simulate the UPI or card payment arriving' })
  async sampleComplete(@Headers('authorization') authorization: string | undefined, @Param('id') id: string) {
    return this.visits.sampleComplete(await this.kiosk(authorization), id);
  }
}
