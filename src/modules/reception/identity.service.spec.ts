import * as assert from 'node:assert/strict';
import { describe, test, before, beforeEach, after } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { QueueService } from '../queue/queue.service';
import { QueueEvents } from '../queue/queue-events';
import { PatientCardsService } from '../queue/patient-cards.service';
import { OpdService } from '../opd/opd.service';
import { SettingsService } from '../settings/settings.service';
import { AppointmentEvents } from '../appointments/appointment-events';
import { clinicNow, isoDate } from '../../common/utils/clinic-time';
import { PatientsService } from '../patients/patients.service';
import { ReceptionIdentityService } from './identity.service';
import { SmsProvider } from './providers/sms-provider';
import { KioskRef } from './reception.types';

const kiosk: KioskRef = { id: 'k1', name: 'Front kiosk' };
const otherKiosk: KioskRef = { id: 'k2', name: 'Side kiosk' };

const codeOf = (error: unknown) => (error as { getResponse(): { code?: string } }).getResponse().code;
const responseOf = (error: unknown) => (error as { getResponse(): Record<string, unknown> }).getResponse();
const rejectsWith = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (e) => {
    assert.equal(codeOf(e), code);
    return true;
  });
};

describe('ReceptionIdentityService', () => {
  const m = () => models();
  let service: ReceptionIdentityService;
  let queue: QueueService;
  let sent: Array<{ phone10: string; code: string }>;
  let clock: Date;

  const build = (sms: SmsProvider | null) => {
    const settings = new SettingsService(m().HospitalSettings);
    const opd = new OpdService(m().Department, m().OpDoctor, settings);
    queue = new QueueService(m().QueueToken, m().QueueSequence, m().Appointment, m().Patient, settings, new QueueEvents(), new AppointmentEvents(), opd);
    const cards = new PatientCardsService(m().PatientCard, m().Patient, queue);
    const config = { get: (key: string) => (key === 'jwt.secret' ? 'test-secret-test-secret-test-secret-1234' : key === 'reception.publicWebUrl' ? 'https://web.example' : undefined) } as unknown as ConfigService;
    return new ReceptionIdentityService(m().ReceptionSession, m().OtpChallenge, m().Patient, m().Appointment, new PatientsService(m().Patient), cards, queue, settings, config, sms, () => clock);
  };

  const fakeSms: SmsProvider = {
    name: 'sample',
    async sendOtp(phone10, code) {
      sent.push({ phone10, code });
    },
  };

  const patient = (uhid: string, extra: Record<string, unknown> = {}) =>
    m().Patient.create({ uhid, name: `Patient ${uhid}`, phone: '+91 98765 43210', gender: 'Female', age: 40, address: '1 Main Road', lastVisit: '12 Sep 2026', department: 'Cardiology', ...extra } as any);

  before(connectTestDb);
  after(closeTestDb);

  beforeEach(async () => {
    await resetTestDb();
    sent = [];
    clock = new Date('2026-09-26T10:00:00.000Z');
    await m().Department.create({ code: 'general-medicine', name: 'General Medicine', tokenPrefix: 'G', order: 1 } as any);
    service = build(fakeSms);
  });

  const advance = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };

  test('card tap returns a masked summary', async () => {
    await patient('U1');
    await m().PatientCard.create({ cardId: '04A1B2C3', uhid: 'U1', linkedBy: 't' });
    const result = await service.identifyByCard(kiosk, '04:a1:b2:c3');
    assert.equal(result.patient.uhid, 'U1');
    assert.equal(result.patient.phone, '••••• 43210');
    assert.equal('address' in result.patient, false);
    assert.equal(result.patient.lastDepartment, 'Cardiology');
    assert.equal(result.activeToken, null);
    assert.deepEqual(await service.resolveSession(kiosk, result.session), { uhid: 'U1', via: 'card' });
  });

  test('card tap shows an appointment today and the active token', async () => {
    await patient('U1');
    await m().PatientCard.create({ cardId: '04A1B2C3', uhid: 'U1', linkedBy: 't' });
    await m().Appointment.create({ uhid: 'U1', patientName: 'Patient U1', age: 40, gender: 'Female', time: '10:30 AM', date: isoDate(clinicNow()), status: 'Scheduled' } as any);
    const result = await service.identifyByCard(kiosk, '04A1B2C3');
    assert.deepEqual(result.appointmentToday, { time: '10:30 AM' });
    assert.equal(result.activeToken, null);

    const issued = await queue.issue({ uhid: 'U1', skipAppointment: true }, 'Tester');
    const again = await service.identifyByCard(kiosk, '04A1B2C3');
    assert.equal(again.activeToken?.label, issued.token.label);
    assert.equal(again.activeToken?.trackUrl, `https://web.example/track#${issued.token.trackCode}`);
    assert.equal(typeof again.activeToken?.issuedAt, 'string');
  });

  test('unknown card is refused with CARD_UNKNOWN', async () => {
    await assert.rejects(service.identifyByCard(kiosk, 'ZZZZ9999'), (e) => {
      assert.equal(codeOf(e), 'CARD_UNKNOWN');
      assert.equal(responseOf(e).message, "This card isn't linked yet. Use Find my record or ask at the counter.");
      return true;
    });
  });

  test('otp send for an unknown number sends nothing and says not found', async () => {
    await patient('U1');
    const r = await service.sendOtp(kiosk, '9000000000');
    assert.equal(r.found, false);
    assert.equal(r.sampleCode, undefined);
    assert.equal(sent.length, 0);
  });

  test('otp treats formatted numbers as one number', async () => {
    await patient('U1');
    const first = await service.sendOtp(kiosk, '+91 98765 43210');
    assert.equal(first.found, true);
    assert.equal(first.resendAfterSeconds, 30);
    assert.equal(sent[0].phone10, '9876543210');
    advance(10);
    await rejectsWith(service.sendOtp(kiosk, '098765 43210'), 'OTP_WAIT');
    advance(25);
    await service.sendOtp(kiosk, '098765 43210');
    const { patients } = await service.verifyOtp(kiosk, '9876543210', sent[1].code);
    assert.equal(patients.length, 1);
    assert.equal(sent.length, 2);
  });

  test('a new code replaces the previous one', async () => {
    await patient('U1');
    await service.sendOtp(kiosk, '9876543210');
    advance(31);
    await service.sendOtp(kiosk, '9876543210');
    if (sent[0].code !== sent[1].code) await rejectsWith(service.verifyOtp(kiosk, '9876543210', sent[0].code), 'OTP_WRONG');
    await service.verifyOtp(kiosk, '9876543210', sent[1].code);
  });

  test('otp wrong code counts down and locks after five', async () => {
    await patient('U1');
    await service.sendOtp(kiosk, '9876543210');
    const wrong = sent[0].code === '000000' ? '111111' : '000000';
    for (const left of [4, 3, 2, 1]) {
      await assert.rejects(service.verifyOtp(kiosk, '9876543210', wrong), (e) => {
        assert.equal(codeOf(e), 'OTP_WRONG');
        assert.equal(responseOf(e).attemptsLeft, left);
        return true;
      });
    }
    await rejectsWith(service.verifyOtp(kiosk, '9876543210', wrong), 'OTP_EXPIRED');
    await rejectsWith(service.verifyOtp(kiosk, '9876543210', sent[0].code), 'OTP_EXPIRED');
  });

  test('otp expires after five minutes and works once', async () => {
    await patient('U1');
    await service.sendOtp(kiosk, '9876543210');
    advance(301);
    await rejectsWith(service.verifyOtp(kiosk, '9876543210', sent[0].code), 'OTP_EXPIRED');
    await service.sendOtp(kiosk, '9876543210');
    await service.verifyOtp(kiosk, '9876543210', sent[1].code);
    await rejectsWith(service.verifyOtp(kiosk, '9876543210', sent[1].code), 'OTP_EXPIRED');
  });

  test('otp limit: fourth send in 15 minutes is refused', async () => {
    await patient('U1');
    for (let i = 0; i < 3; i++) {
      await service.sendOtp(kiosk, '9876543210');
      advance(31);
    }
    await rejectsWith(service.sendOtp(kiosk, '9876543210'), 'OTP_LIMIT');
    advance(15 * 60);
    await service.sendOtp(kiosk, '9876543210');
  });

  test("a send refused by the limit leaves the patient's current code working", async () => {
    await patient('U1');
    for (let i = 0; i < 3; i++) {
      await service.sendOtp(kiosk, '9876543210');
      advance(31);
    }
    await rejectsWith(service.sendOtp(kiosk, '9876543210'), 'OTP_LIMIT');
    assert.equal(sent.length, 3);
    const result = await service.verifyOtp(kiosk, '9876543210', sent[2].code);
    assert.deepEqual(result.patients.map((p) => p.patient.uhid), ['U1']);
  });

  test("a send refused by the kiosk's hourly limit leaves the patient's current code working", async () => {
    await patient('U1');
    await service.sendOtp(kiosk, '9876543210');
    for (let i = 0; i < 29; i++) await service.sendOtp(kiosk, `90000000${String(i).padStart(2, '0')}`);
    advance(31);
    await rejectsWith(service.sendOtp(kiosk, '9876543210'), 'OTP_LIMIT');
    await service.verifyOtp(kiosk, '9876543210', sent[0].code);
  });

  test('otp limit: thirty sends per kiosk per hour', async () => {
    for (let i = 0; i < 30; i++) await service.sendOtp(kiosk, `90000000${String(i).padStart(2, '0')}`);
    await rejectsWith(service.sendOtp(kiosk, '9111111111'), 'OTP_LIMIT');
    await service.sendOtp(otherKiosk, '9111111111');
  });

  test('concurrent wrong guesses cannot exceed five tries, so the right code is then refused', async () => {
    await patient('U1');
    await service.sendOtp(kiosk, '9876543210');
    const wrong = sent[0].code === '000000' ? '111111' : '000000';
    const guesses = await Promise.allSettled(Array(20).fill(wrong).map((c) => service.verifyOtp(kiosk, '9876543210', c)));
    assert.equal(guesses.filter((r) => r.status === 'fulfilled').length, 0);
    assert.equal((await m().OtpChallenge.findOne({ phone10: '9876543210' }).lean())!.attempts, 5);
    await rejectsWith(service.verifyOtp(kiosk, '9876543210', sent[0].code), 'OTP_EXPIRED');
  });

  test('the right code racing wrong guesses is accepted at most once and attempts stay within five', async () => {
    await patient('U1');
    await service.sendOtp(kiosk, '9876543210');
    const wrong = sent[0].code === '000000' ? '111111' : '000000';
    const results = await Promise.allSettled([...Array(20).fill(wrong), sent[0].code].map((c) => service.verifyOtp(kiosk, '9876543210', c)));
    assert.ok(results.filter((r) => r.status === 'fulfilled').length <= 1);
    assert.ok((await m().OtpChallenge.findOne({ phone10: '9876543210' }).lean())!.attempts <= 5);
  });

  test('concurrent sends for one number send one SMS; the rest wait', async () => {
    await patient('U1');
    const results = await Promise.allSettled(Array(10).fill(0).map(() => service.sendOtp(kiosk, '9876543210')));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results) if (r.status === 'rejected') assert.equal(codeOf(r.reason), 'OTP_WAIT');
    assert.equal(sent.length, 1);
    assert.equal(await m().OtpChallenge.countDocuments({ phone10: '9876543210', closed: false }), 1);
  });

  test('verify returns every patient on a shared number with full details', async () => {
    await patient('U1');
    await patient('U2', { name: 'Child Two', phone: '9876543210', age: 6 });
    await service.sendOtp(kiosk, '9876543210');
    const { patients } = await service.verifyOtp(kiosk, '9876543210', sent[0].code);
    assert.deepEqual(patients.map((p) => p.patient.uhid).sort(), ['U1', 'U2']);
    assert.equal(patients[0].patient.phone.includes('9876543210') || patients[0].patient.phone.includes('98765 43210'), true);
    assert.equal(patients.find((p) => p.patient.uhid === 'U1')?.patient.address, '1 Main Road');
    const sessions = new Set(patients.map((p) => p.session));
    assert.equal(sessions.size, 2);
    for (const p of patients) assert.equal((await service.resolveSession(kiosk, p.session)).via, 'otp');
  });

  test('register refuses a known number until confirmNew', async () => {
    await patient('U1');
    await rejectsWith(service.register(kiosk, { name: 'New Person', phone: '98765 43210', gender: 'Male', age: 30 }), 'PHONE_HAS_RECORDS');
    const result = await service.register(kiosk, { name: 'New Person', phone: '98765 43210', gender: 'Male', age: 30, confirmNew: true });
    assert.match(result.patient.uhid, /^MHK\d{4}\d{5}$/);
    const saved = await m().Patient.findOne({ uhid: result.patient.uhid });
    assert.equal(saved?.visitType, 'OPD');
    assert.equal(saved?.status, 'Today');
    assert.equal(saved?.registeredVia, 'Registered at kiosk Front kiosk');
    assert.deepEqual(await service.resolveSession(kiosk, result.session), { uhid: result.patient.uhid, via: 'register' });
  });

  test('register validates name, phone and age; derives age from a date of birth', async () => {
    const base = { name: 'Asha Devi', phone: '9123456780', gender: 'Female' as const };
    await assert.rejects(service.register(kiosk, { ...base, name: 'A', age: 30 }));
    await assert.rejects(service.register(kiosk, { ...base, phone: '12345', age: 30 }));
    await assert.rejects(service.register(kiosk, { ...base, age: 121 }));
    await assert.rejects(service.register(kiosk, { ...base }));
    await assert.rejects(service.register(kiosk, { ...base, dob: '2030-01-01' }));
    // Age comes from the clinic day (CLINIC_DATE-aware), not the injected clock or UTC.
    const [y, mo, d] = isoDate(clinicNow()).split('-').map(Number);
    const dayBefore = `${y - 30}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const r = await service.register(kiosk, { ...base, dob: dayBefore === `${y - 30}-02-29` ? `${y - 30}-02-28` : dayBefore });
    assert.equal(r.patient.age, 30);
  });

  test('session from another kiosk is refused', async () => {
    await patient('U1');
    await m().PatientCard.create({ cardId: '04A1B2C3', uhid: 'U1', linkedBy: 't' });
    const { session } = await service.identifyByCard(kiosk, '04A1B2C3');
    await assert.rejects(service.resolveSession(otherKiosk, session), (e) => {
      assert.equal(codeOf(e), 'SESSION_ENDED');
      assert.equal(responseOf(e).message, 'Your session has ended. Please start again.');
      return true;
    });
    await rejectsWith(service.resolveSession(kiosk, 'nonsense'), 'SESSION_ENDED');
  });

  test('a session ends after fifteen minutes', async () => {
    await patient('U1');
    await m().PatientCard.create({ cardId: '04A1B2C3', uhid: 'U1', linkedBy: 't' });
    const { session } = await service.identifyByCard(kiosk, '04A1B2C3');
    advance(14 * 60);
    await service.resolveSession(kiosk, session);
    advance(2 * 60);
    await rejectsWith(service.resolveSession(kiosk, session), 'SESSION_ENDED');
  });

  test('sessions and codes are stored hashed', async () => {
    await patient('U1');
    await m().PatientCard.create({ cardId: '04A1B2C3', uhid: 'U1', linkedBy: 't' });
    const { session } = await service.identifyByCard(kiosk, '04A1B2C3');
    assert.equal(await m().ReceptionSession.countDocuments({ tokenHash: session }), 0);
    await service.sendOtp(kiosk, '9876543210');
    const stored = await m().OtpChallenge.findOne({ phone10: '9876543210' }).lean();
    assert.ok(stored);
    assert.match(stored.codeHash, /^[0-9a-f]{64}$/);
    assert.equal('code' in stored, false);
  });

  test('sample code is returned only by the sample provider', async () => {
    await patient('U1');
    const r = await service.sendOtp(kiosk, '9876543210');
    assert.equal(r.sampleCode, sent[0].code);
    const off = build(null);
    await assert.rejects(off.sendOtp(kiosk, '9876543210'), (e) => {
      assert.equal(codeOf(e), 'OTP_OFF');
      return true;
    });
  });
});
