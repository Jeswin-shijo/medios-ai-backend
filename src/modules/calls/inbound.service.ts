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
import { CallAgentSettings, resolveCallAgentSettings } from './call-agent-settings';
import { CallResult } from './providers/voice-provider';
import { toE164India } from './phone';
import { appointmentStart, clinicNow, clockMinutes, displayDate, displayDateTime, isoDate, parseIsoDay, spokenDay } from '../../common/utils/clinic-time';

// The inbound agent: a patient phones the hospital and the voice agent (SnapServe)
// calls these tools mid-call. Nothing about an appointment is shared until
// find_patient has matched the caller to a patient record:
//   - the registered mobile number, and
//   - the date of birth when one is on file, otherwise the patient's name.
// The match opens a session whose code (caller_ref) every other tool must quote,
// so changes only ever touch the verified patient's appointments. Answers carry
// first names, dates, times and the doctor; never clinical details.
// Every answer is { ok, message, ...data }: `message` tells the agent what to do next.

const SESSION_MINUTES = 60;
const MAX_FAILURES = 3;
const LOCK_MINUTES = 30;
const UPCOMING = 3;
const SLOT_OFFERS = 3;
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

/** A date of birth in any common spoken or written form → YYYY-MM-DD; null if unreadable. */
export function parseBirthDate(raw: unknown): string | null {
  const s = str(raw).toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/,/g, ' ');
  let y: number, m: number, d: number;
  let match: RegExpExecArray | null;
  if ((match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/.exec(s))) [d, m, y] = [Number(match[1]), MONTHS.indexOf(match[2].slice(0, 3)) + 1, Number(match[3])];
  else if ((match = /^([a-z]+)\s+(\d{1,2})\s+(\d{4})$/.exec(s))) [m, d, y] = [MONTHS.indexOf(match[1].slice(0, 3)) + 1, Number(match[2]), Number(match[3])];
  else return null;
  const date = new Date(y, m - 1, d);
  if (m < 1 || date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d || y < 1900) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

const nameWords = (name: string) => name.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);

/** The caller's version of the name includes the patient's first name ("Rekha" for "Rekha S"). */
export function nameMatches(onRecord: string, spoken: string): boolean {
  const [first] = nameWords(onRecord);
  return !!first && nameWords(spoken).includes(first);
}

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
    const phone = toE164India(str(args.phone)) ?? toE164India(ctx.callerNumber);
    if (!phone) throw new Refusal('Ask for the 10-digit mobile number registered with the hospital, then call find_patient again.');
    const name = str(args.patient_name, 80);
    const dob = parseBirthDate(args.date_of_birth);
    if (!name) throw new Refusal("Ask for the patient's full name (and date of birth), then call find_patient again.");

    const lookup = await this.lookups.findOne({ phone }).exec();
    if (lookup?.lockedUntil && lookup.lockedUntil > new Date()) {
      throw new Refusal('Too many unsuccessful checks for this number. Do not share any details. Tell the caller the front desk will call them back, then end politely.', {
        verified: false,
        locked: true,
      });
    }

    const tail = phone.slice(-5);
    const candidates = (await this.patients.find({ phone: { $regex: tail } }).exec()).filter((p) => toE164India(p.phone) === phone);
    const byName = candidates.filter((p) => nameMatches(p.name, name));
    // A date of birth on file must be given and must match; otherwise the name decides.
    const needsDob = byName.some((p) => p.dob);
    if (needsDob && !dob) {
      throw new Refusal("Ask for the patient's date of birth (day, month and year), then call find_patient again with it.", { verified: false });
    }
    const matched = byName.filter((p) => (p.dob ? parseBirthDate(p.dob) === dob : true));

    if (matched.length !== 1) {
      const attemptsLeft = await this.recordFailure(phone);
      if (attemptsLeft === 0) {
        throw new Refusal('The details still do not match. Do not share anything. Tell the caller the front desk will call them back, then end politely.', {
          verified: false,
          locked: true,
        });
      }
      throw new Refusal(
        matched.length > 1
          ? "Several patients match. Ask for the patient's full name and date of birth, then try again."
          : 'The details do not match our records. Ask the caller to repeat the mobile number, name and date of birth once. Never say which detail was wrong.',
        { verified: false, attempts_left: attemptsLeft },
      );
    }

    const patient = matched[0];
    await this.lookups.deleteOne({ phone }).exec();
    const session = await this.sessions.create({
      code: this.newCode(),
      uhid: patient.uhid,
      patientName: patient.name,
      phone,
      verifiedBy: patient.dob ? 'date of birth' : 'name',
      providerCallId: ctx.providerCallId,
      callerNumber: toE164India(ctx.callerNumber) ?? undefined,
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
      message: `Verified. Use caller_ref ${session.code} in every other tool. ${listed.message}`,
    };
  }

  /** Counts a failed check; returns the attempts left (0 = now locked). */
  private async recordFailure(phone: string): Promise<number> {
    const lookup = await this.lookups
      .findOneAndUpdate(
        { phone },
        { $inc: { failures: 1 }, $set: { expiresAt: new Date(Date.now() + LOCK_MINUTES * 60_000) } },
        { upsert: true, new: true },
      )
      .exec();
    const left = Math.max(MAX_FAILURES - lookup!.failures, 0);
    if (left === 0) {
      await this.lookups.updateOne({ phone }, { $set: { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } }).exec();
      await this.task(`Inbound caller not verified: ${phone}`, `Identity check failed ${MAX_FAILURES} times on a call to the hospital line. Call back on ${phone} to help.`, 'Medium', '');
    }
    return left;
  }

  private async session(args: Record<string, unknown>, ctx: ToolContext): Promise<InboundSessionDocument> {
    const code = str(args.caller_ref, 20).toUpperCase();
    const session = code ? await this.sessions.findOne({ code, expiresAt: { $gt: new Date() } }).exec() : null;
    if (!session) throw new Refusal('Verify the caller first with find_patient, then pass the caller_ref it returns.');
    let changed = false;
    if (ctx.providerCallId && !session.providerCallId) {
      session.providerCallId = ctx.providerCallId;
      changed = true;
    }
    if (ctx.callerNumber && !session.callerNumber) {
      session.callerNumber = toE164India(ctx.callerNumber) ?? undefined;
      changed = true;
    }
    if (changed) await session.save();
    return session;
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
    return apt;
  }

  private async findFreeSlots(session: InboundSessionDocument, args: Record<string, unknown>): Promise<ToolReply> {
    const { cfg } = await this.context();
    const now = clinicNow();
    const preferred = /^\d{4}-\d{2}-\d{2}$/.test(str(args.preferred_date)) ? parseIsoDay(str(args.preferred_date)) : null;
    const from = preferred && preferred > now ? preferred : now;
    const offered = await this.slots.findFree(cfg, from, SLOT_OFFERS);
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
    if (!(await this.slots.isFree(cfg, slot.date, slot.time))) throw new Refusal('That slot was just taken. Call find_free_slots again and offer new times.');
    const patient = await this.patients.findOne({ uhid: session.uhid }).exec();
    if (!patient) throw new Refusal('The patient record is not available. Offer a call back from the front desk.');

    const reason = str(args.reason, 120);
    const apt = await this.appointments.create({
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
    });
    await this.patients.updateOne({ uhid: patient.uhid }, { nextAppointment: `${displayDate(parseIsoDay(slot.date))} ${slot.time}` }).exec();
    await this.note(session, 'booked', `Booked ${displayDate(parseIsoDay(slot.date))}, ${slot.time}.`, String(apt._id));
    return { ok: true, message: `Booked for ${slot.label}. Read it back to the caller and ask them to arrive 10 minutes early.` };
  }

  private async reschedule(session: InboundSessionDocument, args: Record<string, unknown>): Promise<ToolReply> {
    const { cfg } = await this.context();
    await this.assertChangesAllowed(session, 'move an appointment', cfg);
    const apt = await this.appointmentFor(session, args);
    const slot = this.slotFor(session, args);
    if (!(await this.slots.isFree(cfg, slot.date, slot.time, String(apt._id)))) throw new Refusal('That slot was just taken. Call find_free_slots again and offer new times.');
    const before = `${displayDate(parseIsoDay(apt.date))}, ${apt.time}`;
    apt.date = slot.date;
    apt.time = slot.time;
    apt.confirmation = 'Confirmed';
    apt.confirmedAt = new Date();
    apt.notes = [apt.notes, `Moved by phone (AI) from ${before}.`].filter(Boolean).join(' ');
    await apt.save();
    await this.note(session, 'rescheduled', `Moved from ${before} to ${displayDate(parseIsoDay(slot.date))}, ${slot.time}.`, String(apt._id));
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
    await apt.save();
    this.appointmentEvents.statusChanged({ id: String(apt._id), status: 'Canceled' });
    await this.note(session, 'cancelled', `Cancelled ${displayDate(parseIsoDay(apt.date))}, ${apt.time}${reason ? ` (${reason})` : ''}.`, String(apt._id));
    return { ok: true, message: 'Cancelled. Tell the caller, and that they can call again to book.' };
  }

  private async confirm(session: InboundSessionDocument, args: Record<string, unknown>): Promise<ToolReply> {
    const apt = await this.appointmentFor(session, args);
    apt.confirmation = 'Confirmed';
    apt.confirmedAt = new Date();
    await apt.save();
    await this.note(session, 'confirmed', `Confirmed ${displayDate(parseIsoDay(apt.date))}, ${apt.time}.`, String(apt._id));
    return { ok: true, message: 'Confirmed. Thank the caller and ask them to arrive 10 minutes early.' };
  }

  private async requestCallback(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolReply> {
    const code = str(args.caller_ref, 20).toUpperCase();
    const session = code ? await this.sessions.findOne({ code, expiresAt: { $gt: new Date() } }).exec() : null;
    const phone = session?.phone ?? toE164India(str(args.phone)) ?? toE164India(ctx.callerNumber);
    if (!phone) throw new Refusal('Ask for a 10-digit mobile number to call back on, then call request_callback again.');
    const urgent = args.urgent === true || str(args.urgent).toLowerCase() === 'true';
    const reason = str(args.reason, 300) || 'Asked for a call back.';
    const who = session?.patientName ?? `caller ${phone}`;
    await this.task(urgent ? `Call back urgently: ${who}` : `Call back ${who}`, `${reason} (inbound AI call, ${phone})`, urgent ? 'High' : 'Medium', session?.uhid ?? '', session?.patientName);
    if (session) await this.note(session, undefined, `Call back requested${urgent ? ' (urgent)' : ''}: ${reason}`);
    return {
      ok: true,
      message: urgent
        ? 'Staff have been alerted to call back urgently. If it is an emergency, tell them to call 108 now.'
        : 'The front desk will call back. Tell the caller, then end politely.',
    };
  }

  private async note(session: InboundSessionDocument, outcome: string | undefined, action: string, appointmentId?: string) {
    await this.sessions
      .updateOne({ _id: session._id }, { $push: { actions: action }, ...(outcome && { $set: { outcome, ...(appointmentId && { appointmentId }) } }) })
      .exec();
  }

  // ---------------------------------------------------------------- the call log

  /**
   * Logs an inbound call when its post-call result arrives. The changes made during
   * the call come from the caller's session (matched by call id or caller number);
   * an unverified caller is logged without a patient.
   */
  async recordCall(result: CallResult, provider: string): Promise<{ matched: boolean; duplicate?: boolean }> {
    const providerCallId = result.providerCallId != null ? String(result.providerCallId) : undefined;
    if (providerCallId && (await this.calls.exists({ providerCallId, provider }))) return { matched: true, duplicate: true };

    const caller = toE164India(result.fromNumber) ?? undefined;
    const recent = { createdAt: { $gt: new Date(Date.now() - 2 * 3_600_000) } };
    const session =
      (providerCallId ? await this.sessions.findOne({ providerCallId }).exec() : null) ??
      (caller ? await this.sessions.findOne({ $or: [{ callerNumber: caller }, { phone: caller }], ...recent }).sort({ createdAt: -1 }).exec() : null);

    let outcome: CallOutcome = (session?.outcome as CallOutcome) ?? result.outcome;
    if (!session?.outcome && result.unrecognised) outcome = 'enquiry';
    const ended = result.endedAt ?? new Date();
    const started = new Date(ended.getTime() - (result.durationSec ?? 0) * 1000);
    let action = session?.actions.length ? session.actions.join(' ') : 'No changes made.';
    if (outcome === 'escalated' && !session?.actions.some((a) => a.startsWith('Call back'))) {
      await this.task(`Call back urgently: ${session?.patientName ?? `caller ${caller ?? 'unknown'}`}`, result.notes || result.summary || 'Asked for a person during an AI call to the hospital line.', 'High', session?.uhid ?? '', session?.patientName);
      action += ' Care team alerted (high priority) to call back.';
    }

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
    this.logger.log(`Inbound call ${providerCallId ?? ''} logged: ${outcome}`);
    return { matched: true };
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
