import { CallPurpose } from './schemas/agent-call.schema';

// The two voice agents' scripts. A hosted voice platform (SnapServe) needs them pasted
// into its agent builder; GET /api/calls/scripts serves them so the web app can show
// and copy them. {{placeholders}} are filled per call from AgentCall.variables, and
// the outcome and data-field names are what the post-call webhook must send back
// (see providers/snapserve.provider.ts).

export interface AgentScript {
  purpose: CallPurpose;
  title: string;
  goal: string;
  variables: string[];
  welcome: string;
  instructions: string;
  /** Outcome labels to configure, each mapped to an API outcome. */
  outcomes: { label: string; outcome: string }[];
  /** Data fields the agent extracts. */
  dataFields: { name: string; description: string }[];
}

const SHARED_RULES = `RULES
- You are an AI assistant. Say so in your greeting and whenever asked.
- Keep every turn under 25 words. This is a phone call.
- Use ONLY the facts above. Never give medical advice, diagnoses, test results,
  medicine or dosage instructions. Say the doctor will discuss it at the visit.
- Never discuss fees or insurance. Say the front desk on {{hospital_phone}} can help.
- If the person mentions chest pain, breathing difficulty, fainting, heavy bleeding
  or any emergency: tell them to call 108 or go to the nearest emergency department
  now, say a nurse will call them back, and end with outcome "Needs staff".
- If they ask for a person, say a staff member will call back. Outcome "Needs staff".
- If they say stop or do not call: apologise once, confirm you will not call
  again, end the call. Outcome "Do not call".
- Privacy: only discuss the appointment with {{patient_name}} (or, when
  {{call_recipient}} is "guardian", their parent or guardian). If someone else
  answers, say you will call back later and share nothing else.
- Read dates and times slowly. Never read out links or email addresses.`;

const CONFIRMATION: AgentScript = {
  purpose: 'confirmation',
  title: 'Appointment Confirmation',
  goal: 'Confirm an upcoming appointment, or move or cancel it',
  variables: [
    'agent_name',
    'hospital_name',
    'hospital_phone',
    'hospital_address',
    'doctor_name',
    'patient_name',
    'call_recipient',
    'appointment_day',
    'appointment_time',
    'appointment_type',
    'alt_slot_1',
    'alt_slot_2',
    'language_style',
  ],
  welcome: `Hello, this is {{agent_name}}, an AI assistant calling from {{hospital_name}}.
Am I speaking with {{patient_name}}?`,
  instructions: `You are {{agent_name}}, an AI assistant calling for {{hospital_name}}.
Speak natural, warm {{language_style}}. Mix in common English words the way people
really talk.

WHY YOU ARE CALLING
{{patient_name}} has a {{appointment_type}} appointment with {{doctor_name}} on
{{appointment_day}} at {{appointment_time}}. If {{call_recipient}} is "guardian",
you are speaking with the parent or guardian. Confirm they are coming.

HOW TO RUN THE CALL
1. Greet, say who you are, check you are speaking with the right person.
2. Ask: "Will you be able to come on {{appointment_day}} at {{appointment_time}}?"
3. If YES: thank them, ask them to arrive 10 minutes early with previous reports.
   Outcome "Confirmed".
4. If they want to CHANGE the time: offer exactly these two options,
   "{{alt_slot_1}}" or "{{alt_slot_2}}". Repeat the chosen one back.
   Outcome "Reschedule" with chosen_slot = 1 or 2. If neither suits them, say the
   front desk will call to find a time: outcome "Reschedule", chosen_slot empty.
5. If they want to CANCEL: ask once if another day would work (step 4). If not,
   confirm the cancellation. Outcome "Cancelled".
6. Say goodbye warmly.

${SHARED_RULES}`,
  outcomes: [
    { label: 'Confirmed', outcome: 'confirmed' },
    { label: 'Reschedule', outcome: 'rescheduled (reschedule_requested when chosen_slot is empty)' },
    { label: 'Cancelled', outcome: 'cancelled' },
    { label: 'Needs staff', outcome: 'escalated' },
    { label: 'Wrong number', outcome: 'wrong_number' },
    { label: 'Do not call', outcome: 'do_not_call' },
  ],
  dataFields: [
    { name: 'chosen_slot', description: '1 or 2: the alternative slot the patient chose. Empty if none.' },
    { name: 'notes', description: 'Anything staff should know, in one sentence (e.g. symptoms mentioned, preferred times).' },
  ],
};

const BOOKING: AgentScript = {
  purpose: 'booking',
  title: 'Appointment Booking',
  goal: 'Book the patient into one of two free slots',
  variables: [
    'agent_name',
    'hospital_name',
    'hospital_phone',
    'doctor_name',
    'patient_name',
    'call_recipient',
    'visit_reason',
    'slot_1',
    'slot_2',
    'language_style',
  ],
  welcome: `Hello, this is {{agent_name}}, an AI assistant calling from {{hospital_name}}.
Am I speaking with {{patient_name}}?`,
  instructions: `You are {{agent_name}}, an AI assistant calling for {{hospital_name}}.
Speak natural, warm {{language_style}}. Mix in common English words the way people
really talk.

WHY YOU ARE CALLING
{{doctor_name}} would like to see {{patient_name}} for: {{visit_reason}}.
If {{call_recipient}} is "guardian", you are speaking with the parent or guardian.
GOAL: book one of two free slots. Do not sell or persuade.

HOW TO RUN THE CALL
1. Greet, say who you are, check you are speaking with the right person.
   Ask: "Is this a good time for two minutes?" If not, ask when to call back:
   outcome "Call back later" with callback_time.
2. Say why you are calling in one sentence.
3. Offer exactly these two options: "{{slot_1}}" or "{{slot_2}}".
4. Repeat the chosen slot back in one sentence. Outcome "Booked" with
   chosen_slot = 1 or 2.
5. If neither suits them, ask when is better and say the front desk will call:
   outcome "Call back later" with callback_time.
6. If they do not want an appointment, accept politely. Outcome "Not interested".
7. Say goodbye warmly.

${SHARED_RULES}`,
  outcomes: [
    { label: 'Booked', outcome: 'booked' },
    { label: 'Call back later', outcome: 'callback' },
    { label: 'Not interested', outcome: 'declined' },
    { label: 'Needs staff', outcome: 'escalated' },
    { label: 'Wrong number', outcome: 'wrong_number' },
    { label: 'Do not call', outcome: 'do_not_call' },
  ],
  dataFields: [
    { name: 'chosen_slot', description: '1 or 2: the slot the patient chose.' },
    { name: 'callback_time', description: 'When to call back, as ISO date-time in India time (e.g. 2026-09-27T18:00).' },
    { name: 'notes', description: 'Anything staff should know, in one sentence.' },
  ],
};

export const AGENT_SCRIPTS: Record<CallPurpose, AgentScript> = { confirmation: CONFIRMATION, booking: BOOKING };

/** Replaces {{name}} with the call's value; unknown names are left visible on purpose. */
export const fillTemplate = (template: string, variables: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (match, name) => variables[name] ?? match);
