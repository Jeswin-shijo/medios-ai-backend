import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CallOutcome } from '../schemas/agent-call.schema';
import { SimulatedResponse } from '../call-agent-settings';
import { CallResult, CallResultHandler, StartCallRequest, VoiceProvider } from './voice-provider';

// Development stand-in for a voice platform: no phone rings. A few seconds after a
// call "starts" it reports an outcome with a scripted transcript built from the same
// variables a real agent receives, so the whole flow (outcomes, retries, booking,
// alerts) can be exercised without credentials or charges. The API refuses to start
// with this provider in production.

type Line = CallResult['transcript'][number];
const agent = (text: string): Line => ({ speaker: 'agent', text });
const patient = (text: string): Line => ({ speaker: 'patient', text });

/** Picks an outcome from weights, e.g. { confirmed: 60, no_answer: 20 }. */
function weighted(weights: Partial<Record<string, number>>): string {
  const entries = Object.entries(weights) as [string, number][];
  let roll = Math.random() * entries.reduce((sum, [, w]) => sum + w, 0);
  for (const [key, w] of entries) {
    roll -= w;
    if (roll < 0) return key;
  }
  return entries[0][0];
}

const CONFIRMATION_RESPONSES: Record<Exclude<SimulatedResponse, 'random'>, string> = {
  positive: 'confirmed',
  reschedule: 'rescheduled',
  callback: 'reschedule_requested',
  cancel: 'cancelled',
  no_answer: 'no_answer',
  escalate: 'escalated',
  do_not_call: 'do_not_call',
};

const BOOKING_RESPONSES: Record<Exclude<SimulatedResponse, 'random'>, string> = {
  positive: 'booked_1',
  reschedule: 'booked_2',
  callback: 'callback',
  cancel: 'declined',
  no_answer: 'no_answer',
  escalate: 'escalated',
  do_not_call: 'do_not_call',
};

/**
 * A check-up call's questions in asking order, each with its first (all is well)
 * choice; `cardiac` ones are asked only on the cardiac list. Patient Support owns the
 * questions; the rating is a field of its own.
 */
const CHECKUP_OK_ANSWERS: { key: string; ask: string; answer: string; choice: string; cardiac?: boolean }[] = [
  { key: 'medicines', ask: 'Are you taking your medicines as written on the discharge summary?', answer: 'Yes, every day.', choice: 'yes' },
  { key: 'symptoms', ask: 'Any new pain, fever or breathlessness since going home?', answer: 'No, nothing like that.', choice: 'none' },
  { key: 'antiplatelets', ask: 'Are you taking both blood thinners every day?', answer: 'Yes, both of them.', choice: 'yes', cardiac: true },
  { key: 'exertion', ask: 'Any chest pain or breathlessness when walking?', answer: 'No.', choice: 'no', cardiac: true },
  { key: 'followup', ask: 'Do you know when your follow-up is?', answer: 'Yes, it is on the paper.', choice: 'yes' },
  { key: 'question', ask: 'Any questions for the doctor?', answer: 'No, thank you.', choice: 'no' },
];

export class SimulatedProvider implements VoiceProvider {
  readonly name = 'simulated';
  readonly live = false;
  private readonly logger = new Logger('SimulatedCalls');
  private handler?: CallResultHandler;

  constructor(private readonly delayMs: number) {}

  attachResultHandler(handler: CallResultHandler) {
    this.handler = handler;
  }

  async startCall(request: StartCallRequest): Promise<{ providerCallId: string }> {
    const providerCallId = `sim_${randomUUID()}`;
    const result = { ...this.converse(request), callId: request.callId, providerCallId };
    const timer = setTimeout(() => {
      result.endedAt = new Date();
      this.handler?.(result).catch((err) => this.logger.error(`Could not record simulated result: ${err.message}`));
    }, this.delayMs);
    timer.unref();
    return { providerCallId };
  }

  private converse({ purpose, variables: v, simulation }: StartCallRequest): CallResult {
    if (purpose === 'checkup') return this.checkup(v);
    const pick =
      simulation === 'random'
        ? purpose === 'confirmation'
          ? weighted({ confirmed: 55, rescheduled: 12, reschedule_requested: 5, cancelled: 8, no_answer: 17, escalated: 3 })
          : weighted({ booked_1: 35, booked_2: 20, callback: 15, declined: 10, no_answer: 20 })
        : (purpose === 'confirmation' ? CONFIRMATION_RESPONSES : BOOKING_RESPONSES)[simulation];

    if (pick === 'no_answer') {
      return { outcome: 'no_answer', summary: 'No answer. The phone rang for 30 seconds.', transcript: [], durationSec: 0 };
    }

    const guardian = v.call_recipient === 'guardian';
    const opening: Line[] = [
      agent(`Hello, this is ${v.agent_name}, an AI assistant calling from ${v.hospital_name}. Am I speaking with ${guardian ? `the parent or guardian of ${v.patient_name}` : v.patient_name}?`),
      patient(guardian ? `Yes, I'm ${v.patient_name}'s parent.` : 'Yes, speaking.'),
    ];
    const end = (lines: Line[], outcome: CallOutcome, summary: string, extra: Partial<CallResult> = {}): CallResult => {
      const transcript = [...opening, ...lines];
      // Roughly 2.5 words a second, plus pauses.
      const words = transcript.reduce((n, l) => n + l.text.split(/\s+/).length, 0);
      return { outcome, summary, transcript, durationSec: Math.round(words / 2.5) + transcript.length * 2, ...extra };
    };

    if (pick === 'escalated') {
      return end(
        [
          agent(`I'm calling about ${guardian ? 'the' : 'your'} appointment with ${v.doctor_name}. Is this a good time?`),
          patient('Yes, but I have had chest pain since this morning and feel breathless.'),
          agent(`I'm sorry to hear that. I'm an AI assistant and can't give medical advice. If it is severe, please call 108 or go to the nearest emergency department now. A nurse will call you back right away.`),
          patient('Okay, thank you.'),
        ],
        'escalated',
        'Patient reported chest pain since the morning and breathlessness. Advised emergency care; nurse callback promised.',
        { notes: 'Chest pain since morning, breathless.' },
      );
    }
    if (pick === 'do_not_call') {
      return end(
        [agent(`I'm calling from ${v.hospital_name} about an appointment.`), patient('Please stop calling me.'), agent("I'm sorry for the trouble. We won't call you again. Goodbye.")],
        'do_not_call',
        'Asked not to be called again.',
      );
    }

    if (purpose === 'confirmation') {
      const ask = agent(`I'm calling to confirm the ${v.appointment_type} appointment with ${v.doctor_name} on ${v.appointment_day} at ${v.appointment_time}. Will you be able to come?`);
      switch (pick) {
        case 'confirmed':
          return end(
            [ask, patient("Yes, I'll be there."), agent(`Thank you. Please arrive ten minutes early and bring any previous reports. See you on ${v.appointment_day}. Goodbye!`)],
            'confirmed',
            `Confirmed the appointment on ${v.appointment_day} at ${v.appointment_time}.`,
          );
        case 'rescheduled':
          if (v.alt_slot_1) {
            return end(
              [
                ask,
                patient("I can't make it then. Can we change it?"),
                agent(`Of course. I can offer ${v.alt_slot_1}, or ${v.alt_slot_2 || 'another time through the front desk'}. Which works better?`),
                patient('The first one, please.'),
                agent(`Done. Your appointment is now ${v.alt_slot_1}. See you then. Goodbye!`),
              ],
              'rescheduled',
              `Could not come at the booked time; chose ${v.alt_slot_1}.`,
              { chosenSlot: 1 },
            );
          }
          break;
        case 'cancelled':
          return end(
            [
              ask,
              patient("I won't be able to come. Please cancel it."),
              agent('Would another day work for you?'),
              patient('No, not right now.'),
              agent(`I've cancelled the appointment. You can call ${v.hospital_phone} whenever you'd like to book again. Take care.`),
            ],
            'cancelled',
            'Cancelled the appointment; did not want another day.',
          );
      }
      return end(
        [
          ask,
          patient("I can't come then, and I'm not sure when I'm free. Can someone call me later?"),
          agent('Of course. The front desk will call you to find a new time. Goodbye!'),
        ],
        'reschedule_requested',
        'Cannot come at the booked time; wants the front desk to call to find a new one.',
        { notes: 'Prefers to be called after 5 PM.' },
      );
    }

    // Booking
    const offer = agent(`${v.doctor_name} would like to see ${guardian ? v.patient_name : 'you'} for ${v.visit_reason}. I can offer ${v.slot_1}, or ${v.slot_2}. Which suits you?`);
    switch (pick) {
      case 'booked_1':
      case 'booked_2': {
        const n = pick === 'booked_2' && v.slot_2 ? 2 : 1;
        const slot = n === 1 ? v.slot_1 : v.slot_2;
        return end(
          [offer, patient(n === 1 ? 'The first one works.' : 'The second one is better for me.'), agent(`You're booked for ${slot}. Please bring any previous reports. Goodbye!`)],
          'booked',
          `Booked ${slot} for ${v.visit_reason}.`,
          { chosenSlot: n },
        );
      }
      case 'callback': {
        const at = new Date();
        at.setHours(18, 0, 0, 0);
        if (at.getTime() < Date.now() + 30 * 60_000) at.setDate(at.getDate() + 1);
        return end(
          [agent('Is this a good time for two minutes?'), patient("I'm at work. Can you call me after 6 in the evening?"), agent("Sure, I'll call you back after 6 PM. Goodbye!")],
          'callback',
          'Busy at work; asked for a call back after 6 PM.',
          { callbackAt: at },
        );
      }
      default:
        return end(
          [offer, patient("I don't need an appointment right now, thanks."), agent(`No problem. If you change your mind, call ${v.hospital_phone}. Take care.`)],
          'declined',
          'Does not want an appointment now.',
        );
    }
  }

  /** A check-up call where all is well: every first choice, and a rating of 5. */
  private checkup(v: Record<string, string>): CallResult {
    const questions = CHECKUP_OK_ANSWERS.filter((q) => !q.cardiac || v.question_list === 'cardiac');
    const transcript: Line[] = [
      agent(
        `Hello, this is an AI assistant calling from the hospital to check on ${v.patient_name} after going home. Is this a good time for a few questions?`,
      ),
      patient('Yes, go ahead.'),
      ...questions.flatMap((q) => [agent(q.ask), patient(q.answer)]),
      agent('How would you rate your stay, 1 to 5?'),
      patient('Five.'),
      agent('Thank you. Take care, and call the hospital if anything changes. Goodbye!'),
    ];
    const words = transcript.reduce((n, l) => n + l.text.split(/\s+/).length, 0);
    return {
      outcome: 'enquiry',
      summary: 'Check-up call: all answers were fine; rated the stay 5.',
      transcript,
      durationSec: Math.round(words / 2.5) + transcript.length * 2,
      answers: Object.fromEntries(questions.map((q) => [q.key, q.choice])),
      rating: 5,
    };
  }
}
