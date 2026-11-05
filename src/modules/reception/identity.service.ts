import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { clinicNow, isoDate } from '../../common/utils/clinic-time';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Model } from 'mongoose';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { Appointment, AppointmentDocument } from '../appointments/schemas/appointment.schema';
import { PatientsService } from '../patients/patients.service';
import { PatientCardsService } from '../queue/patient-cards.service';
import { QueueService } from '../queue/queue.service';
import { SettingsService } from '../settings/settings.service';
import { last10, maskPhone, newSecret, sha256 } from './format';
import { resolveReceptionSettings } from './reception-settings';
import { SMS_PROVIDER, SmsProvider } from './providers/sms-provider';
import { OtpChallenge, OtpChallengeDocument } from './schemas/otp-challenge.schema';
import { ReceptionSession, ReceptionSessionDocument } from './schemas/reception-session.schema';
import { IdentifyResult, KioskRef, PatientSummary } from './reception.types';
import { resolveTrackingBase, toKioskTokenView } from './token-view';

/** Injection token for the clock, so tests can move time. */
export const RECEPTION_CLOCK = 'RECEPTION_CLOCK';

const SESSION_MINUTES = 15;
const OTP_VALID_SECONDS = 300;
const OTP_RESEND_SECONDS = 30;
const OTP_MAX_WRONG = 5;
const OTP_PER_NUMBER = 3;
const OTP_PER_NUMBER_WINDOW_MS = 15 * 60 * 1000;
const OTP_PER_KIOSK = 30;
const HOUR_MS = 60 * 60 * 1000;
const CHECKABLE = ['Scheduled', 'Checked In', 'Waiting'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface RegisterInput {
  name: string;
  phone: string;
  gender: 'Male' | 'Female' | 'Other';
  age?: number;
  dob?: string;
  confirmNew?: boolean;
}

/** An error whose response carries a machine-readable `code` the tablet acts on. */
const coded = (Type: new (response: object) => HttpException, message: string, code: string, extra: object = {}) => new Type({ message, code, ...extra });

const TooMany = class extends HttpException {
  constructor(response: object) {
    super(response, HttpStatus.TOO_MANY_REQUESTS);
  }
};

const SESSION_ENDED = () => coded(UnauthorizedException, 'Your session has ended. Please start again.', 'SESSION_ENDED');
const OTP_EXPIRED = () => coded(BadRequestException, 'That code has expired. Ask for a new one.', 'OTP_EXPIRED');

/** Matches a stored phone in any format by its last ten digits ("98765 43210", "+91-98765-43210"). */
function phoneRegex(phone10: string): RegExp {
  return new RegExp(`${phone10.split('').join('\\D*')}\\D*$`);
}

@Injectable()
export class ReceptionIdentityService {
  constructor(
    @InjectModel(ReceptionSession.name) private readonly sessions: Model<ReceptionSessionDocument>,
    @InjectModel(OtpChallenge.name) private readonly challenges: Model<OtpChallengeDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    @InjectModel(Appointment.name) private readonly appointments: Model<AppointmentDocument>,
    private readonly patientsService: PatientsService,
    private readonly cards: PatientCardsService,
    private readonly queue: QueueService,
    private readonly settings: SettingsService,
    private readonly config: ConfigService,
    @Optional() @Inject(SMS_PROVIDER) private readonly sms: SmsProvider | null,
    @Optional() @Inject(RECEPTION_CLOCK) private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------------------------------------------------------------- card tap

  async identifyByCard(kiosk: KioskRef, rawCardId: string): Promise<IdentifyResult> {
    const card = await this.cards.findByCard(rawCardId);
    const patient = card ? await this.patients.findOne({ uhid: card.uhid }).exec() : null;
    if (!patient) {
      throw coded(NotFoundException, "This card isn't linked yet. Use Find my record or ask at the counter.", 'CARD_UNKNOWN');
    }
    return this.identified(kiosk, patient, 'card', false);
  }

  // ---------------------------------------------------------------- OTP

  async sendOtp(kiosk: KioskRef, phone: string): Promise<{ found: boolean; resendAfterSeconds: number; sampleCode?: string }> {
    if (!this.sms) throw coded(ServiceUnavailableException, 'Finding your record by mobile number is not available. Please ask at the counter.', 'OTP_OFF');
    const phone10 = last10(phone);
    if (!phone10) throw new BadRequestException('Enter a 10-digit mobile number.');

    const now = this.now();
    const waitError = (seconds: number) => coded(TooMany, `Please wait ${seconds} seconds before asking for another code.`, 'OTP_WAIT', { resendAfterSeconds: seconds });
    const limitError = () => coded(TooMany, 'Too many codes have been requested. Please ask at the counter.', 'OTP_LIMIT');

    const lastSend = await this.challenges.findOne({ phone10, found: true }).sort({ sentAt: -1 }).exec();
    if (lastSend) {
      const wait = Math.ceil((lastSend.sentAt.getTime() + OTP_RESEND_SECONDS * 1000 - now.getTime()) / 1000);
      if (wait > 0) throw waitError(wait);
    }

    const row = { phone10, kioskId: kiosk.id, sentAt: now, expiresAt: new Date(now.getTime() + HOUR_MS) };
    if (!(await this.patients.exists({ phone: phoneRegex(phone10) }))) {
      const unknown = await this.challenges.create({ ...row, found: false, validUntil: now, closed: true });
      if ((await this.kioskSends(kiosk.id, now)) > OTP_PER_KIOSK) {
        await this.challenges.deleteOne({ _id: unknown._id });
        throw limitError();
      }
      return { found: false, resendAfterSeconds: OTP_RESEND_SECONDS };
    }

    // The unique index on open codes lets one send per number through; the rest get OTP_WAIT.
    // Only codes already past the resend gap are closed, so a racing send cannot close ours.
    await this.challenges.updateMany(
      { phone10, found: true, closed: false, sentAt: { $lte: new Date(now.getTime() - OTP_RESEND_SECONDS * 1000) } },
      { $set: { closed: true } },
    );
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    let mine: OtpChallengeDocument;
    try {
      mine = await this.challenges.create({ ...row, found: true, codeHash: this.codeHash(phone10, code), validUntil: new Date(now.getTime() + OTP_VALID_SECONDS * 1000) });
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) throw waitError(OTP_RESEND_SECONDS);
      throw err;
    }

    // Counted after our own row is in, so concurrent sends cannot all slip under the limit.
    const [forNumber, forKiosk] = await Promise.all([
      this.challenges.countDocuments({ phone10, found: true, sentAt: { $gt: new Date(now.getTime() - OTP_PER_NUMBER_WINDOW_MS) } }),
      this.kioskSends(kiosk.id, now),
    ]);
    if (forNumber > OTP_PER_NUMBER || forKiosk > OTP_PER_KIOSK) {
      await this.challenges.deleteOne({ _id: mine._id });
      throw limitError();
    }

    await this.sms.sendOtp(phone10, code);
    return { found: true, resendAfterSeconds: OTP_RESEND_SECONDS, sampleCode: this.sms.name === 'sample' ? code : undefined };
  }

  private kioskSends(kioskId: string, now: Date) {
    return this.challenges.countDocuments({ kioskId, sentAt: { $gt: new Date(now.getTime() - HOUR_MS) } });
  }

  async verifyOtp(kiosk: KioskRef, phone: string, code: string): Promise<{ patients: IdentifyResult[] }> {
    const phone10 = last10(phone);
    const now = this.now();
    // Only the newest code for the number counts; older ones were replaced.
    const latest = phone10 ? await this.challenges.findOne({ phone10, found: true }).sort({ sentAt: -1 }).exec() : null;
    if (!latest || latest.kioskId !== kiosk.id) throw OTP_EXPIRED();

    // Take an attempt before comparing, so parallel guesses cannot exceed the limit.
    const attempt = await this.challenges
      .findOneAndUpdate({ _id: latest._id, closed: false, attempts: { $lt: OTP_MAX_WRONG }, validUntil: { $gt: now } }, { $inc: { attempts: 1 } }, { new: true })
      .exec();
    if (!attempt) throw OTP_EXPIRED();

    if (!this.sameHash(attempt.codeHash, this.codeHash(phone10, String(code ?? '').trim()))) {
      if (attempt.attempts >= OTP_MAX_WRONG) {
        await this.challenges.updateOne({ _id: attempt._id }, { $set: { closed: true } });
        throw OTP_EXPIRED();
      }
      throw coded(BadRequestException, 'That code is not right. Please try again.', 'OTP_WRONG', { attemptsLeft: OTP_MAX_WRONG - attempt.attempts });
    }

    // Single use: only the request that closes the row gets in.
    const used = await this.challenges.findOneAndUpdate({ _id: attempt._id, closed: false }, { $set: { closed: true } }).exec();
    if (!used) throw OTP_EXPIRED();

    const found = await this.patients.find({ phone: phoneRegex(phone10) }).sort({ createdAt: 1 }).exec();
    return { patients: await Promise.all(found.map((p) => this.identified(kiosk, p, 'otp', true))) };
  }

  // ---------------------------------------------------------------- registration

  async register(kiosk: KioskRef, input: RegisterInput): Promise<IdentifyResult> {
    const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 80) throw new BadRequestException('Enter the full name (2 to 80 letters).');
    const phone10 = last10(String(input.phone ?? ''));
    if (!phone10) throw new BadRequestException('Enter a 10-digit mobile number.');
    if (!['Male', 'Female', 'Other'].includes(input.gender)) throw new BadRequestException('Choose Male, Female or Other.');
    const { age, dob } = this.ageAndDob(input);

    if (input.confirmNew !== true && (await this.patients.exists({ phone: phoneRegex(phone10) }))) {
      throw coded(ConflictException, 'This number already has a record. Choose it, or confirm that this is a new person.', 'PHONE_HAS_RECORDS');
    }

    const patient = await this.patientsService.create({
      name,
      phone: phone10,
      gender: input.gender,
      age,
      dob,
      visitType: 'OPD',
      status: 'Today',
      registeredVia: `Registered at kiosk ${kiosk.name}`,
    } as never);
    return this.identified(kiosk, patient, 'register', true);
  }

  // ---------------------------------------------------------------- sessions

  async resolveSession(kiosk: KioskRef, session: string): Promise<{ uhid: string; via: 'card' | 'otp' | 'register' }> {
    const row = typeof session === 'string' && session ? await this.sessions.findOne({ tokenHash: sha256(session) }).exec() : null;
    if (!row || row.kioskId !== kiosk.id || row.expiresAt <= this.now()) throw SESSION_ENDED();
    return { uhid: row.uhid, via: row.via as 'card' | 'otp' | 'register' };
  }

  // ---------------------------------------------------------------- internals

  private async identified(kiosk: KioskRef, patient: PatientDocument, via: 'card' | 'otp' | 'register', full: boolean): Promise<IdentifyResult> {
    const session = newSecret();
    await this.sessions.create({
      tokenHash: sha256(session),
      uhid: patient.uhid,
      kioskId: kiosk.id,
      via,
      expiresAt: new Date(this.now().getTime() + SESSION_MINUTES * 60 * 1000),
    });

    const [token, appointment, settings] = await Promise.all([
      this.queue.activeTokenFor(patient.uhid),
      this.appointments.findOne({ uhid: patient.uhid, date: this.queue.today(), status: { $in: CHECKABLE } }).sort({ time: 1 }).exec(),
      this.settings.getSettings() as unknown as Promise<Record<string, unknown>>,
    ]);
    const base = resolveTrackingBase(resolveReceptionSettings(settings.reception), this.config.get<string>('reception.publicWebUrl'));
    return {
      session,
      patient: this.summary(patient, full),
      activeToken: token ? toKioskTokenView(await this.queue.kioskView(token, true), base) : null,
      appointmentToday: appointment ? { time: appointment.time } : null,
    };
  }

  private summary(patient: PatientDocument, full: boolean): PatientSummary {
    return {
      uhid: patient.uhid,
      name: patient.name,
      age: patient.age,
      gender: patient.gender,
      phone: full ? patient.phone : maskPhone(patient.phone),
      lastVisit: patient.lastVisit || undefined,
      lastDepartment: patient.lastVisit ? patient.department || undefined : undefined,
      ...(full && patient.address ? { address: patient.address } : {}),
    };
  }

  private ageAndDob(input: RegisterInput): { age: number; dob?: string } {
    if (input.dob) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.dob);
      const [y, mo, d] = match ? match.slice(1).map(Number) : [0, 0, 0];
      const born = new Date(Date.UTC(y, mo - 1, d));
      const valid = match && born.getUTCFullYear() === y && born.getUTCMonth() === mo - 1 && born.getUTCDate() === d;
      const [ty, tm, td] = isoDate(clinicNow()).split('-').map(Number);
      const today = new Date(Date.UTC(ty, tm - 1, td));
      if (!valid || born > today) throw new BadRequestException('Enter a valid date of birth.');
      let age = today.getUTCFullYear() - y;
      if (today.getUTCMonth() < mo - 1 || (today.getUTCMonth() === mo - 1 && today.getUTCDate() < d)) age -= 1;
      if (age > 120) throw new BadRequestException('Enter a valid date of birth.');
      return { age, dob: `${d} ${MONTHS[mo - 1]} ${y}` };
    }
    if (!Number.isInteger(input.age) || input.age < 0 || input.age > 120) throw new BadRequestException('Enter an age from 0 to 120, or a date of birth.');
    return { age: input.age };
  }

  private codeHash(phone10: string, code: string): string {
    return createHmac('sha256', String(this.config.get('jwt.secret'))).update(`${phone10}:${code}`).digest('hex');
  }

  private sameHash(a: string, b: string): boolean {
    return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
}
