import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomInt } from 'crypto';
import { AgentCall, AgentCallDocument, CallOutcome } from './schemas/agent-call.schema';
import { InboundSession, InboundSessionDocument } from './schemas/inbound-session.schema';
import { CallerLookup, CallerLookupDocument } from './schemas/caller-lookup.schema';
import { Appointment, AppointmentDocument } from '../appointments/schemas/appointment.schema';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { AppointmentEvents } from '../appointments/appointment-events';
import { TasksAlertsService } from '../tasks-alerts/tasks-alerts.service';
import { SettingsService } from '../settings/settings.service';
import { SlotsService } from './slots.service';
import { SchedulingAppointmentsService } from '../scheduling/scheduling-appointments.service';
import { CallAgentSettings, resolveCallAgentSettings } from './call-agent-settings';
import { CallResult } from './providers/voice-provider';
import { toE164India } from './phone';
import { appointmentStart, clinicNow, clockMinutes, displayDate, displayDateTime, isoDate, parseIsoDay, spokenDay } from '../../common/utils/clinic-time';

// The inbound agent: a patient phones the hospital and the voice agent (SnapServe)
// calls these tools mid-call. Nothing about an appointment is shared until
// find_patient has matched the caller to a patient record by the registered mobile
// number and the patient's full name, plus:
//   - calling from that number (caller ID): the date of birth when one is on file;
//   - from any other number, or with no caller ID: a date of birth on file, which
//     must match. Without one the caller cannot be verified on the line, and staff
//     call back the number on record.
// The match opens a session whose code (caller_ref) every other tool must quote,
// so changes only ever touch the verified patient's appointments. Answers carry
// first names, dates, times and the doctor; never clinical details.
// Every answer is { ok, message, ...data }: `message` tells the agent what to do next.

const SESSION_MINUTES = 20;
const MAX_FAILURES = 3;
/** The failure count lapses this long after the last failure. */
const FAILURE_MINUTES = 30;
/** Each lock within LOCK_MEMORY_HOURS lasts longer: 30 minutes, 2 hours, then 24 hours. */
const LOCK_MINUTES = [30, 120, 24 * 60];
const LOCK_MEMORY_HOURS = 24;
const UPCOMING = 3;
const SLOT_OFFERS = 3;
/** The furthest ahead a caller can book. */
const MAX_DAYS_AHEAD = 90;
/** Slack around a call's start and end when its result is matched to a session by number. */
const MATCH_MARGIN_MS = 2 * 60_000;
const DAY_MS = 86_400_000;
/** The agent's verdicts that outrank whatever the call changed. */
const PROVIDER_FIRST: CallOutcome[] = ['escalated', 'wrong_number', 'unverified'];

// The replies to a failed check never say which detail was wrong, or how many tries are left.
const ASK_DOB = "Ask the caller for the patient's date of birth, then try again.";
const NO_MATCH =
  "Those details do not match our records. Ask the caller to check the registered mobile number, the patient's full name and date of birth and try once more, or offer a call back from the front desk (request_callback). Never say which detail was wrong.";
const LOCKED_NOW = 'Those details do not match our records. Do not share anything. Tell the caller the front desk will call them back, then end politely.';
const LOCKED = 'Too many unsuccessful checks for this number. Do not share any details. Tell the caller the front desk will call them back, then end politely.';
const NO_SESSION = 'Verify the caller first with find_patient, then pass the caller_ref it returns.';
/** Codes avoid look-alike characters (0/O, 1/I) so they survive being read aloud. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const INBOUND_TOOLS = [
  'find_patient',
  'list_appointments',
  'find_free_slots',
  'book_appointment',
  'reschedule_appointment',
  'cancel_appointment',
  'confirm_appointment',
  'request_callback',
] as const;
export type InboundTool = (typeof INBOUND_TOOLS)[number];

export type ToolReply = { ok: boolean; message: string } & Record<string, unknown>;

/** What SnapServe tells us about the call itself, when the tool request carries it. */
export interface ToolContext {
  providerCallId?: string;
  callerNumber?: string;
}

/** A refusal the agent should hear: answered as { ok: false, message }. */
class Refusal extends Error {
  constructor(
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const str = (value: unknown, max = 200) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, max) : '');

/** "92" → 1992, "14" → 2014: this century unless that is still to come. */
const fullYear = (y: string) => {
  if (y.length === 4) return Number(y);
  const thisCentury = 2000 + Number(y);
  return thisCentury <= new Date().getFullYear() ? thisCentury : thisCentury - 100;
};

/** A date of birth in any common spoken or written form → YYYY-MM-DD; null if unreadable. */
export function parseBirthDate(raw: unknown): string | null {
  const s = str(raw)
    .toLowerCase()
    .replace(/^(\d{4}-\d{2}-\d{2})t[\d:.]+(z|[+-][\d:]+)?$/, '$1') // an imported ISO timestamp
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/,/g, ' ')
    .replace(/\s+of\s+/g, ' ')
    .trim();
  let y: number, m: number, d: number;
  let match: RegExpExecArray | null;
  if ((match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(s))) [d, m, y] = [Number(match[1]), Number(match[2]), fullYear(match[3])];
  else if ((match = /^(\d{1,2})\s+([a-z]+)\s+(\d{4}|\d{2})$/.exec(s))) [d, m, y] = [Number(match[1]), MONTHS.indexOf(match[2].slice(0, 3)) + 1, fullYear(match[3])];
  else if ((match = /^([a-z]+)\s+(\d{1,2})\s+(\d{4}|\d{2})$/.exec(s))) [m, d, y] = [MONTHS.indexOf(match[1].slice(0, 3)) + 1, Number(match[2]), fullYear(match[3])];
  else return null;
  const date = new Date(y, m - 1, d);
  if (m < 1 || date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d || y < 1900) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Titles said before a name; ignored on both sides. */
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'smt', 'shri', 'sri', 'thiru', 'selvi', 'master', 'baby']);
/** Words the caller may say beyond the name on record ("Rekha Suresh Kumar" for "Rekha Suresh"). */
const MAX_EXTRA_WORDS = 2;

const nameWords = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !HONORIFICS.has(w));

/** Whether the name has any Latin letters: names must be spelt in English letters. */
export const readableName = (name: string) => /[a-z]/i.test(name);

/**
 * The caller said the patient's full name: every word on record longer than one
 * letter (initials such as the "P" in "Suresh P" are optional), with at most two
 * extra words, so a list of common names does not match.
 */
export function nameMatches(onRecord: string, spoken: string): boolean {
  const record = nameWords(onRecord);
  const required = record.filter((w) => w.length > 1);
  const said = new Set(nameWords(spoken));
  if (!required.length || !required.every((w) => said.has(w))) return false;
  const extra = [...said].filter((w) => !record.includes(w));
  return extra.length <= MAX_EXTRA_WORDS;
}

const TAKEN = 'That slot was just taken. Call find_free_slots again and offer new times.';
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

@Injectable()
export class InboundService {
  private readonly logger = new Logger('InboundAgent');

  constructor(
    @InjectModel(AgentCall.name) private readonly calls: Model<AgentCallDocument>,
    @InjectModel(InboundSession.name) private readonly sessions: Model<InboundSessionDocument>,
    @InjectModel(CallerLookup.name) private readonly lookups: Model<CallerLookupDocument>,
    @InjectModel(Appointment.name) private readonly appointments: Model<AppointmentDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
    private readonly appointmentEvents: AppointmentEvents,
    private readonly tasks: TasksAlertsService,
    private readonly settings: SettingsService,
    private readonly slots: SlotsService,
    private readonly scheduling?: SchedulingAppointmentsService,
  ) {}

  async run(tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolReply> {
    if (!(INBOUND_TOOLS as readonly string[]).includes(tool)) throw new NotFoundException(`Unknown tool "${tool}"`);
    try {
      switch (tool as InboundTool) {
        case 'find_patient':
          return await this.findPatient(args, ctx);
        case 'list_appointments':
          return await this.listAppointments(await this.session(args, ctx));
        case 'find_free_slots':
          return await this.findFreeSlots(await this.session(args, ctx), args);
        case 'book_appointment':
          return await this.book(await this.session(args, ctx), args);
        case 'reschedule_appointment':
          return await this.reschedule(await this.session(args, ctx), args);
        case 'cancel_appointment':
          return await this.cancel(await this.session(args, ctx), args);
        case 'confirm_appointment':
          return await this.confirm(await this.session(args, ctx), args);
        case 'request_callback':
          return await this.requestCallback(args, ctx);
      }
    } catch (err) {
      if (err instanceof Refusal) return { ok: false, message: err.message, ...err.extra };
      this.logger.error(`Tool ${tool} failed: ${(err as Error).message}`);
      return { ok: false, message: 'Something went wrong on our side. Apologise and offer a call back from the front desk (request_callback).' };
    }
  }

  // ---------------------------------------------------------------- identity

  private async findPatient(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolReply> {
    const callerId = toE164India(ctx.callerNumber);
    const phone = toE164India(str(args.phone)) ?? callerId;
    if (!phone) throw new Refusal('Ask for the 10-digit mobile number registered with the hospital, then call find_patient again.');
    const name = str(args.patient_name, 80);
    if (!name) throw new Refusal("Ask for the patient's full name and date of birth, then call find_patient again.");

    const lookup = await this.lookups.findOne({ phone }).exec();
    if (lookup?.lockedUntil && lookup.lockedUntil > new Date()) throw new Refusal(LOCKED, { verified: false, locked: true });
    if (!readableName(name)) throw new Refusal('Ask the caller to spell the name in English letters, then call find_patient again.', { verified: false });

    // Calling from the registered number itself, the full name is enough when no date
    // of birth is on file. From any other number a date of birth on file must match.
    const fromRecordNumber = callerId === phone;
    const dob = parseBirthDate(args.date_of_birth);
    const candidates = await this.patientsOn(phone);
    // Decided before the name is looked at, so this reply says nothing about who matched.
    if (!dob && (!fromRecordNumber || candidates.some((p) => p.birthDate))) throw new Refusal(ASK_DOB, { verified: false });

    // Full name first. With a date of birth given, a patient whose DOB on file matches it
    // wins; if any name-matched patient has a DOB on file and none matches, that is a
    // failed check. Only then do patients with no DOB on file count, so a wrong guess for
    // one patient is never verified as a relative with no DOB.
    const byName = candidates.filter((p) => nameMatches(p.name, name));
    let matched = byName.filter((p) => !p.birthDate);
    if (dob && byName.some((p) => p.birthDate)) matched = byName.filter((p) => p.birthDate === dob);
    // Still several: without a DOB, ask for it; with one, it did not tell them apart.
    if (matched.length > 1 && !dob) throw new Refusal(ASK_DOB, { verified: false });
    if (matched.length !== 1) {
      if ((await this.recordFailure(phone)) === 0) throw new Refusal(LOCKED_NOW, { verified: false, locked: true });
      throw new Refusal(NO_MATCH, { verified: false });
    }

    const patient = matched[0];
    if (!fromRecordNumber && !patient.birthDate) {
      // Nothing on file to check from another number: staff call back the number on record.
      throw new Refusal(NO_MATCH, { verified: false });
    }
    const session = await this.sessions.create({
      code: this.newCode(),
      uhid: patient.uhid,
      patientName: patient.name,
      phone,
      verifiedBy: !fromRecordNumber ? 'name and date of birth' : patient.birthDate ? 'caller ID, name and date of birth' : 'caller ID and name',
      providerCallId: ctx.providerCallId,
      callerNumber: callerId ?? undefined,
      expiresAt: new Date(Date.now() + SESSION_MINUTES * 60_000),
    });
    const listed = await this.listAppointments(session);
    const now = clinicNow();
    return {
      ...listed,
      verified: true,
      caller_ref: session.code,
      patient_first_name: firstName(patient.name),
      ...(patient.age < 18 && { note: 'The patient is a child: you are probably speaking with a parent or guardian.' }),
      today: `${spokenDay(now)} ${now.getFullYear()}`,
      message: `Verified. Pass caller_ref to every other tool, and never read it aloud. ${listed.message}`,
    };
  }

  /** Patients registered on this number, with the date of birth on file read (null when none, or unreadable). */
  private async patientsOn(phone: string) {
    const tail = phone.slice(-5);
    const found = await this.patients.find({ phone: { $regex: tail } }, { uhid: 1, name: 1, phone: 1, dob: 1, age: 1 }).lean().exec();
    return found
      .filter((p) => toE164India(p.phone) === phone)
      .map((p) => {
        const birthDate = p.dob ? parseBirthDate(p.dob) : null;
        if (p.dob && !birthDate) this.logger.warn(`Patient ${p.uhid}: the date of birth on file cannot be read, so it is ignored. Correct it in the patient record.`);
        return { ...p, birthDate };
      });
  }

  /**
   * Counts a failed check; returns the attempts left (0 = now locked). A success never
   * clears the count: it lapses 30 minutes after the last failure.
   */
  private async recordFailure(phone: string): Promise<number> {
    const now = new Date();
    await this.lookups.updateOne({ phone, failuresUntil: { $lte: now } }, { $set: { failures: 0 } }).exec();
    const failuresUntil = new Date(now.getTime() + FAILURE_MINUTES * 60_000);
    const lookup = (await this.lookups
      .findOneAndUpdate({ phone }, { $inc: { failures: 1 }, $set: { failuresUntil }, $max: { expiresAt: failuresUntil } }, { upsert: true, new: true })
      .exec())!;
    const left = Math.max(MAX_FAILURES - lookup.failures, 0);
    if (left === 0) await this.lock(lookup);
    return left;
  }

  /** Locks lookups for the number; each lock within 24 hours lasts longer, and repeats alert an admin. */
  private async lock(lookup: CallerLookupDocument) {
    const now = Date.now();
    const locks = lookup.locksUntil && lookup.locksUntil.getTime() > now ? (lookup.locks ?? 0) + 1 : 1;
    const minutes = LOCK_MINUTES[Math.min(locks, LOCK_MINUTES.length) - 1];
    const lockedUntil = new Date(now + minutes * 60_000);
    const locksUntil = new Date(now + LOCK_MEMORY_HOURS * 3_600_000);
    await this.lookups
      .updateOne({ _id: lookup._id }, { $set: { failures: 0, locks, lockedUntil, locksUntil }, $max: { expiresAt: lockedUntil > locksUntil ? lockedUntil : locksUntil } })
      .exec();
    const { phone } = lookup;
    await this.task(`Inbound caller not verified: ${phone}`, `Identity check failed ${MAX_FAILURES} times on a call to the hospital line. Call back on ${phone} to help.`, 'Medium', '');
    if (locks < 2) return;
    // Never the full number or a name: this goes to whoever reads the alert list.
    await this.tasks.create({
      title: `Repeated failed caller checks from …${phone.slice(-4)}`,
      subtitle: `Lock ${locks} in 24 hours on the hospital line: checks for this number are paused for ${minutes >= 60 ? `${minutes / 60} hours` : `${minutes} minutes`}. Someone may be guessing a patient's details.`,
      patientName: '',
      uhid: '',
      type: 'System',
      priority: 'High',
      category: 'System',
      dueDateTime: displayDateTime(clinicNow()),
      status: 'Pending',
    });
  }

  private async session(args: Record<string, unknown>, ctx: ToolContext): Promise<InboundSessionDocument> {
    const session = await this.liveSession(args, ctx);
    if (!session) throw new Refusal(NO_SESSION);
    return session;
  }

  /**
   * The caller_ref's session, when this call may use it. A session is bound to the
   * first call id it sees, or to the caller's number while no call id has come.
   */
  private async liveSession(args: Record<string, unknown>, ctx: ToolContext): Promise<InboundSessionDocument | null> {
    const code = str(args.caller_ref, 20).toUpperCase();
    const session = code ? await this.sessions.findOne({ code, expiresAt: { $gt: new Date() } }).exec() : null;
    if (!session) return null;
    const callId = ctx.providerCallId;
    const caller = toE164India(ctx.callerNumber) ?? undefined;
    if (session.providerCallId) return callId === session.providerCallId ? session : null;
    if (session.callerNumber && caller !== session.callerNumber) return null;
    if (!callId && (!caller || session.callerNumber)) return session;
    // First sight of the call: bind to it (unless another call got there first).
    return this.sessions
      .findOneAndUpdate(
        { _id: session._id, providerCallId: { $exists: false } },
        { $set: { ...(callId && { providerCallId: callId }), ...(caller && !session.callerNumber && { callerNumber: caller }) } },
        { new: true },
      )
      .exec();
  }

  private newCode() {
    return Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  }

  // ---------------------------------------------------------------- appointments

  private async listAppointments(session: InboundSessionDocument): Promise<ToolReply> {
    const [{ doctor }, upcoming] = await Promise.all([this.context(), this.upcoming(session.uhid)]);
    session.appointments = upcoming.map((a, i) => ({ code: `A${i + 1}`, appointmentId: String(a._id) }));
    await session.save();
    return {
      ok: true,
      appointments: upcoming.map((a, i) => ({
        appointment_id: `A${i + 1}`,
        day: spokenDay(parseIsoDay(a.date)),
        time: a.time,
        doctor,
        type: a.type,
        confirmed: a.confirmation === 'Confirmed',
      })),
      message: upcoming.length ? 'Tell the caller about their appointment if they ask. Use appointment_id to change one.' : 'They have no upcoming appointments. Offer to book one.',
    };
  }

  private async upcoming(uhid: string): Promise<AppointmentDocument[]> {
    const now = clinicNow();
    const list = await this.appointments.find({ uhid, status: 'Scheduled', date: { $gte: isoDate(now) } }).exec();
    return list
      .filter((a) => appointmentStart(a.date, a.time) > now)
      .sort((a, b) => a.date.localeCompare(b.date) || clockMinutes(a.time) - clockMinutes(b.time))
      .slice(0, UPCOMING);
  }

  private async appointmentFor(session: InboundSessionDocument, args: Record<string, unknown>): Promise<AppointmentDocument> {
    const code = str(args.appointment_id, 10).toUpperCase();
    const ref = session.appointments.find((a) => a.code === code);
    if (!ref) throw new Refusal('Unknown appointment_id. Call list_appointments and use one of the ids it returns.');
    const apt = await this.appointments.findOne({ _id: ref.appointmentId, uhid: session.uhid }).exec();
    if (!apt || apt.status !== 'Scheduled') throw new Refusal('That appointment can no longer be changed. Call list_appointments again.');
    if (appointmentStart(apt.date, apt.time) <= clinicNow()) throw new Refusal('That appointment time has already passed, so it cannot be changed. Call list_appointments again.');
    return apt;
  }

  private async findFreeSlots(session: InboundSessionDocument, args: Record<string, unknown>): Promise<ToolReply> {
    const { cfg } = await this.context();
    const now = clinicNow();
    const preferred = /^\d{4}-\d{2}-\d{2}$/.test(str(args.preferred_date)) ? parseIsoDay(str(args.preferred_date)) : null;
    if (preferred && preferred.getTime() > now.getTime() + MAX_DAYS_AHEAD * DAY_MS) {
      throw new Refusal(`Appointments can be booked up to ${MAX_DAYS_AHEAD} days ahead. Ask for an earlier day, or offer a call back from the front desk (request_callback).`);
    }
    const from = preferred && preferred > now ? preferred : now;
    // To move an appointment, the slots are that appointment's own doctor's (reschedule checks the pick against the same doctor).
    const apt = str(args.appointment_id) ? await this.appointmentFor(session, args) : null;
    const doctor = await this.slots.doctorFor(apt ? { doctorId: apt.doctorId, uhid: session.uhid } : { uhid: session.uhid });
    const offered = await this.slots.findFree(cfg, from, SLOT_OFFERS, undefined, doctor ? String(doctor._id) : undefined);
    session.slots = offered.map((s, i) => ({ code: `S${i + 1}`, date: s.date, time: s.time, label: s.label }));
    await session.save();
    if (!offered.length) throw new Refusal('No free slots in the next two weeks. Offer a call back from the front desk (request_callback).');
    return {
      ok: true,
      slots: offered.map((s, i) => ({ slot_id: `S${i + 1}`, when: s.label })),
      message: 'Offer at most two of these. Book only the one the caller chooses, using its slot_id.',
    };
  }

  private slotFor(session: InboundSessionDocument, args: Record<string, unknown>) {
    const code = str(args.slot_id, 10).toUpperCase();
    const slot = session.slots.find((s) => s.code === code);
    if (!slot) throw new Refusal('Unknown slot_id. Call find_free_slots and use one of the ids it returns.');
    return slot as Required<typeof slot>;
  }

  private async assertChangesAllowed(session: InboundSessionDocument, what: string, cfg: CallAgentSettings) {
    if (cfg.inboundChanges) return;
    await this.task(`${session.patientName} asked to ${what} by phone`, `Inbound caller (${session.phone}) asked to ${what}. Call back to arrange it.`, 'Medium', session.uhid, session.patientName);
    throw new Refusal(`Changes by phone are handled by the front desk. Tell the caller the front desk will call back to ${what}.`);
  }

  private async book(session: InboundSessionDocument, args: Record<string, unknown>): Promise<ToolReply> {
    const { cfg } = await this.context();
    await this.assertChangesAllowed(session, 'book an appointment', cfg);
    const slot = this.slotFor(session, args);
    const doctor = await this.slots.doctorFor({ uhid: session.uhid });
    if (!(await this.slots.isFree(cfg, slot.date, slot.time, undefined, doctor ? String(doctor._id) : undefined))) throw new Refusal(TAKEN);
    const patient = await this.patients.findOne({ uhid: session.uhid }).exec();
    if (!patient) throw new Refusal('The patient record is not available. Offer a call back from the front desk.');

    const reason = str(args.reason, 120);
    let apt: AppointmentDocument;
    await this.slots.releaseStale(this.slots.fieldsFor(doctor, slot.date, slot.time));
    try {
      apt = await this.appointments.create({
        uhid: patient.uhid,
        patientName: patient.name,
        age: patient.age,
        gender: patient.gender,
        avatar: patient.avatar,
        phone: patient.phone,
        date: slot.date,
        time: slot.time,
        type: 'Consultation',
        condition: reason,
        status: 'Scheduled',
        confirmation: 'Confirmed',
        confirmedAt: new Date(),
        bookedVia: 'AI call (inbound)',
        notes: reason ? `Booked by phone (AI): ${reason}` : 'Booked by phone (AI).',
        tags: patient.conditions ?? [],
        ...this.slots.fieldsFor(doctor, slot.date, slot.time),
      });
    } catch (e) {
      if ((e as any)?.code === 11000) throw new Refusal(TAKEN); // the database guard: taken between the check and the save
      throw e;
    }
    await this.refreshNextAppointment(patient.uhid);
    await this.note(session, `Booked ${displayDate(parseIsoDay(slot.date))}, ${slot.time}.`, { outcome: 'booked', appointmentId: String(apt._id) });
    return { ok: true, message: `Booked for ${slot.label}. Read it back to the caller and ask them to arrive 10 minutes early.` };
  }

  private async reschedule(session: InboundSessionDocument, args: Record<string, unknown>): Promise<ToolReply> {
    const { cfg } = await this.context();
    await this.assertChangesAllowed(session, 'move an appointment', cfg);
    const apt = await this.appointmentFor(session, args);
    const slot = this.slotFor(session, args);
    const doctor = await this.slots.doctorFor({ doctorId: apt.doctorId, uhid: apt.uhid });
    if (!(await this.slots.isFree(cfg, slot.date, slot.time, String(apt._id), doctor ? String(doctor._id) : undefined))) throw new Refusal(TAKEN);
    const before = `${displayDate(parseIsoDay(apt.date))}, ${apt.time}`;
    const old = { id: String(apt._id), doctorId: apt.doctorId, date: apt.date, time: apt.time };
    apt.date = slot.date;
    apt.time = slot.time;
    const newFields = this.slots.fieldsFor(doctor, slot.date, slot.time);
    await this.slots.releaseStale(newFields);
    Object.assign(apt, newFields);
    apt.confirmation = 'Confirmed';
    apt.confirmedAt = new Date();
    apt.notes = [apt.notes, `Moved by phone (AI) from ${before}.`].filter(Boolean).join(' ');
    try {
      await apt.save();
    } catch (e) {
      if ((e as any)?.code === 11000) throw new Refusal(TAKEN);
      throw e;
    }
    await this.freed(old);
    await this.refreshNextAppointment(apt.uhid);
    await this.note(session, `Moved from ${before} to ${displayDate(parseIsoDay(slot.date))}, ${slot.time}.`, { outcome: 'rescheduled', appointmentId: String(apt._id) });
    return { ok: true, message: `Moved to ${slot.label}. Read the new time back to the caller.` };
  }

  private async cancel(session: InboundSessionDocument, args: Record<string, unknown>): Promise<ToolReply> {
    const { cfg } = await this.context();
    await this.assertChangesAllowed(session, 'cancel an appointment', cfg);
    const apt = await this.appointmentFor(session, args);
    const reason = str(args.reason, 120);
    apt.status = 'Canceled';
    apt.confirmation = 'Cancelled by Patient';
    apt.notes = [apt.notes, `Cancelled by phone (AI)${reason ? `: ${reason}` : ''}.`].filter(Boolean).join(' ');
    apt.set('slotKey', undefined); // releases the slot for the database guard
    await apt.save();
    await this.freed({ id: String(apt._id), doctorId: apt.doctorId, date: apt.date, time: apt.time });
    this.appointmentEvents.statusChanged({ id: String(apt._id), status: 'Canceled' });
    const when = `${displayDate(parseIsoDay(apt.date))}, ${apt.time}`;
    // The same front-desk alert as a cancellation on an outbound call.
    await this.task(`Appointment cancelled by ${session.patientName}`, [`The ${when} slot is free again.`, reason && `Reason: ${reason}.`].filter(Boolean).join(' '), 'Low', session.uhid, session.patientName);
    await this.note(session, `Cancelled ${when}${reason ? ` (${reason})` : ''}.`, { outcome: 'cancelled', appointmentId: String(apt._id) });
    return { ok: true, message: 'Cancelled. Tell the caller, and that they can call again to book.' };
  }

  /** A slot the agent gave up goes to the same listeners as a front-desk cancel (the waitlist). */
  private async freed(slot: { id: string; doctorId?: string; date: string; time: string }) {
    if (!slot.doctorId || !this.scheduling) return;
    await this.scheduling.slotFreed({ id: slot.id, doctorId: slot.doctorId, date: slot.date, time: slot.time });
  }

  private async confirm(session: InboundSessionDocument, args: Record<string, unknown>): Promise<ToolReply> {
    const apt = await this.appointmentFor(session, args);
    apt.confirmation = 'Confirmed';
    apt.confirmedAt = new Date();
    await apt.save();
    await this.note(session, `Confirmed ${displayDate(parseIsoDay(apt.date))}, ${apt.time}.`, { outcome: 'confirmed', appointmentId: String(apt._id) });
    return { ok: true, message: 'Confirmed. Thank the caller and ask them to arrive 10 minutes early.' };
  }

  private async requestCallback(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolReply> {
    const session = await this.liveSession(args, ctx);
    const phone = session?.phone ?? toE164India(str(args.phone)) ?? toE164India(ctx.callerNumber);
    if (!phone) throw new Refusal('Ask for a 10-digit mobile number to call back on, then call request_callback again.');
    const urgent = args.urgent === true || str(args.urgent).toLowerCase() === 'true';
    const reason = str(args.reason, 300) || 'Asked for a call back.';
    const who = session?.patientName ?? `caller ${phone}`;
    await this.task(urgent ? `Call back urgently: ${who}` : `Call back ${who}`, `${reason} (inbound AI call, ${phone})`, urgent ? 'High' : 'Medium', session?.uhid ?? '', session?.patientName);
    if (session) await this.note(session, `Call back requested${urgent ? ' (urgent)' : ''}: ${reason}`, urgent ? { urgent: true } : undefined);
    return {
      ok: true,
      message: urgent
        ? 'Staff have been alerted to call back urgently. If it is an emergency, tell them to call 108 now.'
        : 'The front desk will call back. Tell the caller, then end politely.',
    };
  }

  /** Records what the call did; `set` holds the last change (outcome, appointmentId) or the urgent flag. */
  private async note(session: InboundSessionDocument, action: string, set?: { outcome?: string; appointmentId?: string; urgent?: boolean }) {
    await this.sessions.updateOne({ _id: session._id }, { $push: { actions: action }, ...(set && { $set: set }) }).exec();
  }

  /** The patient's next visit, as the patient record shows it: the earliest upcoming one. */
  private async refreshNextAppointment(uhid: string) {
    const [next] = await this.upcoming(uhid);
    if (next) await this.patients.updateOne({ uhid }, { nextAppointment: `${displayDate(parseIsoDay(next.date))} ${next.time}` }).exec();
  }

  // ---------------------------------------------------------------- the call log

  /**
   * Logs an inbound call when its post-call result arrives. The changes made during
   * the call come from the caller's session (matched by call id or caller number);
   * an unverified caller is logged without a patient. The agent's "Needs staff",
   * "Wrong number" and "Not verified" outrank what the call changed. A result
   * delivered twice is logged once (a unique index on the provider's call id).
   */
  async recordCall(result: CallResult, provider: string): Promise<{ matched: boolean; duplicate?: boolean }> {
    const providerCallId = result.providerCallId != null ? String(result.providerCallId) : undefined;
    if (providerCallId && (await this.calls.exists({ providerCallId, provider }))) return { matched: true, duplicate: true };

    const caller = toE164India(result.fromNumber) ?? undefined;
    const ended = result.endedAt ?? new Date();
    const started = new Date(ended.getTime() - (result.durationSec ?? 0) * 1000);
    const session = await this.sessionOfCall(providerCallId, caller, result.durationSec != null ? started : undefined, ended);

    const outcome: CallOutcome =
      !result.unrecognised && PROVIDER_FIRST.includes(result.outcome)
        ? result.outcome
        : ((session?.outcome as CallOutcome | undefined) ?? (result.unrecognised ? 'enquiry' : result.outcome));
    let action = session?.actions.length ? session.actions.join(' ') : 'No changes made.';
    // The backup for an agent that ended with "Needs staff" without raising an urgent callback.
    const backupAlert = outcome === 'escalated' && !session?.urgent;
    if (backupAlert) action += ' Care team alerted (high priority) to call back.';

    try {
      await this.calls.create({
        purpose: 'inbound',
        status: 'completed',
        outcome,
        uhid: session?.uhid ?? '',
        patientName: session?.patientName ?? 'Unverified caller',
        phone: caller ?? result.fromNumber ?? 'unknown',
        appointmentId: session?.appointmentId,
        scheduledFor: started,
        startedAt: started,
        endedAt: ended,
        durationSec: result.durationSec,
        trigger: 'inbound',
        requestedBy: 'Caller',
        provider,
        providerCallId,
        summary: result.summary,
        transcript: result.transcript,
        result: { notes: result.notes },
        actionTaken: session ? `Verified by ${session.verifiedBy}. ${action}` : action,
        ...(result.raw && { rawResult: result.raw }),
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return { matched: true, duplicate: true };
      throw err;
    }
    // The call is over: its session ends with it.
    if (session) await this.sessions.updateOne({ _id: session._id }, { $set: { loggedAt: new Date(), expiresAt: new Date() } }).exec();
    if (backupAlert) {
      await this.task(`Call back urgently: ${session?.patientName ?? `caller ${caller ?? 'unknown'}`}`, result.notes || result.summary || 'Asked for a person during an AI call to the hospital line.', 'High', session?.uhid ?? '', session?.patientName);
    }
    this.logger.log(`Inbound call ${providerCallId ?? ''} logged: ${outcome}`);
    return { matched: true };
  }

  /**
   * The session a call's result belongs to: the one bound to its call id, else the one
   * session from the caller's phone that is not bound to another call, not yet logged,
   * and opened during the call (start and end ± 2 minutes; the start is known from the
   * call's length). A session counts as from the caller's phone by its caller number, or
   * by the number it claimed when it has no caller number. When more than one fits,
   * none is attached: the call is logged as unverified rather than under a guess.
   */
  private async sessionOfCall(providerCallId: string | undefined, caller: string | undefined, started: Date | undefined, ended: Date) {
    const unlogged = { loggedAt: { $exists: false } };
    if (providerCallId) {
      const own = await this.sessions.findOne({ providerCallId, ...unlogged }).exec();
      if (own) return own;
    }
    if (!caller) return null;
    const from = started ? new Date(started.getTime() - MATCH_MARGIN_MS) : new Date(ended.getTime() - 2 * 3_600_000);
    const fits = await this.sessions
      .find({
        $or: [{ callerNumber: caller }, { phone: caller, callerNumber: { $exists: false } }],
        providerCallId: providerCallId ? { $in: [null, providerCallId] } : null,
        createdAt: { $gte: from, $lte: new Date(ended.getTime() + MATCH_MARGIN_MS) },
        ...unlogged,
      })
      .limit(2)
      .exec();
    if (fits.length > 1) this.logger.warn(`Inbound call ${providerCallId ?? ''}: several caller checks fit, so none is attached.`);
    return fits.length === 1 ? fits[0] : null;
  }

  // ---------------------------------------------------------------- helpers

  private async context() {
    const s = (await this.settings.getSettings()) as unknown as Record<string, any>;
    return { cfg: resolveCallAgentSettings(s.callAgent), doctor: String(s.profile?.name || 'the doctor') };
  }

  private task(title: string, subtitle: string, priority: 'High' | 'Medium' | 'Low', uhid: string, patientName = '') {
    return this.tasks.create({
      title,
      subtitle,
      patientName: patientName || 'Inbound caller',
      uhid,
      type: 'Patient Communication',
      priority,
      category: priority === 'High' ? 'Critical' : 'Follow-up',
      dueDateTime: displayDateTime(clinicNow()),
      status: 'Pending',
    });
  }
}
