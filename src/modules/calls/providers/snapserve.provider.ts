import { Logger } from '@nestjs/common';
import { CallOutcome } from '../schemas/agent-call.schema';
import { CallResult, ProviderError, StartCallRequest, VoiceProvider } from './voice-provider';

// SnapServe AI (app.snapserve.ai) runs the voice agents; Vobiz or another carrier
// attached to each agent in SnapServe places the actual call.
//   start:  POST {baseUrl}/calls/outbound  { agentId, toNumber, variables }
//   result: SnapServe's post-call notify (or a call.completed event subscription)
//           POSTs to /api/calls/webhook/snapserve?token=CALL_WEBHOOK_SECRET
// Payload field names below follow SnapServe's docs; parseSnapServeResult accepts the
// few shapes seen in practice. Check one real payload before going live.

export interface SnapServeConfig {
  baseUrl: string;
  apiKey: string;
  confirmationAgentId: string;
  bookingAgentId: string;
}

const START_TIMEOUT_MS = 15_000;

const STATUS_MESSAGES: Record<number, string> = {
  401: 'SnapServe rejected the API key. Check SNAPSERVE_API_KEY (it starts with sk_live_).',
  402: 'The SnapServe wallet is empty. Top it up, then retry.',
  403: 'SnapServe refused the call: quiet hours, a DNC-registered number, incomplete Vobiz KYC, or an unfinished agent compliance prompt.',
  404: 'SnapServe does not know this agent, or no phone number is attached to it. Check the agent ids.',
};

export class SnapServeProvider implements VoiceProvider {
  readonly name = 'snapserve';
  readonly live = true;
  private readonly logger = new Logger('SnapServe');

  constructor(private readonly config: SnapServeConfig) {}

  async startCall({ purpose, toNumber, variables }: StartCallRequest): Promise<{ providerCallId: string }> {
    const agentId = purpose === 'confirmation' ? this.config.confirmationAgentId : this.config.bookingAgentId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), START_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/calls/outbound`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: /^\d+$/.test(agentId) ? Number(agentId) : agentId, toNumber, variables }),
        signal: controller.signal,
      });
    } catch (err) {
      // The request may still have reached SnapServe, so never retry automatically.
      throw new ProviderError(
        (err as Error).name === 'AbortError'
          ? 'SnapServe did not answer within 15 seconds. Check SnapServe → Calls before retrying, so the patient is not called twice.'
          : `Could not reach SnapServe: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      this.logger.warn(`Outbound call refused (${res.status})`);
      throw new ProviderError(STATUS_MESSAGES[res.status] ?? `SnapServe refused the call (${res.status}): ${body?.message ?? body?.error ?? 'no details'}`);
    }
    const id = body?.id ?? body?.callId ?? body?.call?.id ?? body?.data?.id;
    if (id == null) throw new ProviderError('SnapServe accepted the call but returned no call id.');
    return { providerCallId: String(id) };
  }
}

/** Outcome labels configured on the agents (see agent-scripts.ts), compared without case or spaces. */
const OUTCOME_LABELS: Record<string, CallOutcome> = {
  confirmed: 'confirmed',
  reschedule: 'rescheduled',
  rescheduled: 'rescheduled',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  booked: 'booked',
  visitbooked: 'booked',
  appointmentbooked: 'booked',
  callbacklater: 'callback',
  callback: 'callback',
  notinterested: 'declined',
  declined: 'declined',
  wrongnumber: 'wrong_number',
  donotcall: 'do_not_call',
  dnc: 'do_not_call',
  needsstaff: 'escalated',
  escalated: 'escalated',
};

/** Call statuses that mean nobody answered. */
const UNANSWERED: Record<string, CallOutcome> = {
  nopickup: 'no_answer',
  noanswer: 'no_answer',
  unanswered: 'no_answer',
  voicemail: 'no_answer',
  busy: 'busy',
  failed: 'failed',
  canceled: 'failed',
};

const key = (value: unknown) => String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');

function transcriptLines(raw: unknown): CallResult['transcript'] {
  const speaker = (role: unknown) => (/^(agent|assistant|bot|ai)/i.test(String(role)) ? 'agent' : 'patient');
  if (Array.isArray(raw)) {
    return raw
      .map((t: any) => ({ speaker: speaker(t?.role ?? t?.speaker), text: String(t?.content ?? t?.text ?? t?.message ?? '').trim() }) as const)
      .filter((l) => l.text);
  }
  if (typeof raw === 'string') {
    return raw
      .split(/\r?\n/)
      .map((line) => /^\s*([A-Za-z ]+):\s*(.+)$/.exec(line))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ speaker: speaker(m[1]), text: m[2].trim() }) as const);
  }
  return [];
}

/**
 * Normalizes a SnapServe post-call payload. Post-call notify sends fields at the top
 * level; event subscriptions wrap them in `data`.
 */
export function parseSnapServeResult(body: any): CallResult {
  const p = body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : (body ?? {});
  const disposition = p.dispositionResult ?? p.disposition_result ?? {};
  const label = p.disposition ?? p.outcome ?? p.dispositionName ?? disposition.disposition ?? disposition.outcome;
  const callStatus = key(p.status ?? p.callStatus);

  let outcome: CallOutcome | undefined = OUTCOME_LABELS[key(label)] ?? UNANSWERED[callStatus];
  const unrecognised = outcome ? undefined : String(label ?? p.status ?? 'none');
  outcome ??= 'failed';

  const slot = Number(disposition.chosen_slot ?? disposition.chosenSlot);
  const chosenSlot = slot === 1 || slot === 2 ? slot : undefined;
  if (outcome === 'rescheduled' && !chosenSlot) outcome = 'reschedule_requested';

  const callback = disposition.callback_time ? new Date(disposition.callback_time) : undefined;
  const duration = Number(p.duration ?? p.durationSec ?? p.callDuration);

  return {
    callId: p.variables?.call_ref ?? p.metadata?.call_ref,
    providerCallId: p.callId ?? p.id ?? p.call_id ?? p.call?.id,
    outcome,
    chosenSlot,
    callbackAt: callback && !Number.isNaN(callback.getTime()) ? callback : undefined,
    notes: disposition.notes ? String(disposition.notes).slice(0, 500) : undefined,
    summary: String(p.callSummary ?? p.summary ?? '').slice(0, 2000),
    transcript: transcriptLines(p.transcript),
    durationSec: Number.isFinite(duration) ? Math.round(duration) : undefined,
    endedAt: new Date(),
    unrecognised,
  };
}
