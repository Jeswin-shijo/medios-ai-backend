import { Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { CallOutcome } from '../schemas/agent-call.schema';
import { CallResult, ProviderCheck, ProviderError, StartCallRequest, VoiceProvider } from './voice-provider';

// SnapServe AI (app.snapserve.ai) runs the voice agents; Vobiz or another carrier
// attached to each agent in SnapServe places the actual call.
//   start:  POST {baseUrl}/calls/outbound  { agentId, toNumber, variables }
//           → { id, status: "initiated", agentId, toNumber, fromNumber }
//   result: the agent's post-call notify (the call object itself) or a
//           call.completed event subscription ({ event, timestamp, data: call })
//           POSTs to /api/calls/webhook/snapserve?token=CALL_WEBHOOK_SECRET.
//           The outcome and the data fields arrive in `dispositionResult`, keyed
//           by field name.
//   inbound: the inbound agent's mid-call tools call /api/calls/tools/<name>
//           (see inbound.service.ts).
// Field names follow SnapServe's docs (Aug 2026). Calls whose result cannot be read
// keep the raw payload (AgentCall.rawResult) so the mapping can be checked.

export interface SnapServeConfig {
  baseUrl: string;
  apiKey: string;
  confirmationAgentId: string;
  bookingAgentId: string;
  inboundAgentId: string;
  signingSecret: string;
}

const START_TIMEOUT_MS = 15_000;
const CHECK_TIMEOUT_MS = 10_000;

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

  private url(path: string) {
    return `${this.config.baseUrl.replace(/\/$/, '')}${path}`;
  }

  async startCall({ purpose, toNumber, variables }: StartCallRequest): Promise<{ providerCallId: string }> {
    const agentId = purpose === 'confirmation' ? this.config.confirmationAgentId : this.config.bookingAgentId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), START_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(this.url('/calls/outbound'), {
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

  /** Reads each configured agent and the wallet: proves the key and ids without a call. */
  async check(): Promise<ProviderCheck> {
    const roles: [string, string][] = [
      ['confirmation', this.config.confirmationAgentId],
      ['booking', this.config.bookingAgentId],
      ['inbound', this.config.inboundAgentId],
    ];
    const agents = await Promise.all(
      roles
        .filter(([, id]) => id)
        .map(async ([role, agentId]) => {
          const { status, body } = await this.get(`/agents/${encodeURIComponent(agentId)}`);
          if (status !== 200) return { role, agentId, ok: false, detail: STATUS_MESSAGES[status] ?? `SnapServe answered ${status || 'nothing'}.` };
          const active = typeof body?.isActive === 'boolean' ? body.isActive : typeof body?.status === 'string' ? /active|published|production/i.test(body.status) : undefined;
          return {
            role,
            agentId,
            ok: true,
            name: typeof body?.name === 'string' ? body.name : undefined,
            active,
            detail:
              active !== false
                ? 'Found and live.'
                : body?.status === 'inactive'
                  ? 'Found, but switched off in SnapServe.'
                  : 'Found, but still a draft: SnapServe puts an agent live once a phone number is assigned on its Calling tab.',
          };
        }),
    );
    const wallet = await this.get('/wallet');
    const balanceInr =
      typeof wallet.body?.balanceInr === 'number' ? wallet.body.balanceInr : typeof wallet.body?.balanceCents === 'number' ? wallet.body.balanceCents / 100 : undefined;
    return {
      provider: this.name,
      // Ready to call: every agent found and active, and money in the wallet.
      ok: wallet.status === 200 && (balanceInr ?? 1) > 0 && agents.every((a) => a.ok && a.active !== false),
      agents,
      wallet:
        wallet.status === 200
          ? { ok: true, balanceInr, detail: balanceInr === undefined ? 'Wallet read.' : balanceInr <= 0 ? 'The wallet is empty: calls will be refused.' : `About ${Math.floor(balanceInr / 5)} minutes at ₹5/min.` }
          : { ok: false, detail: STATUS_MESSAGES[wallet.status] ?? `SnapServe answered ${wallet.status || 'nothing'}.` },
    };
  }

  private async get(path: string): Promise<{ status: number; body: any }> {
    try {
      const res = await fetch(this.url(path), { headers: { Authorization: `Bearer ${this.config.apiKey}` }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch {
      return { status: 0, body: null };
    }
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
  informationgiven: 'enquiry',
  enquiry: 'enquiry',
  notverified: 'unverified',
  unverified: 'unverified',
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
  cancelled: 'failed',
};

const key = (value: unknown) => String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');

/** A data field by name, however the agent spelt it: "chosen_slot", "Chosen slot", "chosenSlot". */
function field(fields: Record<string, unknown>, ...names: string[]): unknown {
  const wanted = new Set(names.map(key));
  for (const [name, value] of Object.entries(fields)) if (wanted.has(key(name))) return value;
  return undefined;
}

const present = (value: unknown) => (value === null || value === undefined || value === '' ? undefined : value);

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
 * Normalizes a SnapServe result. Post-call notify sends the call object itself; event
 * subscriptions wrap it in `data`. `dispositionResult` holds the outcome and the
 * agent's data fields keyed by name (older payloads sent just the outcome label).
 */
export function parseSnapServeResult(body: any): CallResult {
  const p = body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : (body ?? {});
  const disposition = p.dispositionResult ?? p.disposition_result;
  const fields: Record<string, unknown> = disposition && typeof disposition === 'object' && !Array.isArray(disposition) ? disposition : {};
  const label =
    present(p.disposition) ?? present(p.outcome) ?? present(p.dispositionName) ?? (typeof disposition === 'string' ? present(disposition) : present(field(fields, 'outcome', 'disposition')));
  const callStatus = key(p.status ?? p.callStatus);

  let outcome: CallOutcome | undefined = OUTCOME_LABELS[key(label)] ?? UNANSWERED[callStatus];
  const unrecognised = outcome ? undefined : String(label ?? p.status ?? 'none');
  outcome ??= 'failed';

  const slot = Number(field(fields, 'chosen_slot'));
  const chosenSlot = slot === 1 || slot === 2 ? slot : undefined;
  if (outcome === 'rescheduled' && !chosenSlot) outcome = 'reschedule_requested';

  const callbackRaw = present(field(fields, 'callback_time'));
  const callback = callbackRaw ? new Date(String(callbackRaw)) : undefined;
  const notes = present(field(fields, 'notes'));
  const duration = Number(p.durationSeconds ?? p.duration ?? p.durationSec ?? p.callDuration);
  const direction = key(p.direction);

  return {
    callId: p.variables?.call_ref ?? p.metadata?.call_ref,
    providerCallId: p.callId ?? p.id ?? p.call_id ?? p.call?.id,
    outcome,
    chosenSlot,
    callbackAt: callback && !Number.isNaN(callback.getTime()) ? callback : undefined,
    notes: notes ? String(notes).slice(0, 500) : undefined,
    summary: String(p.callSummary ?? p.summary ?? '').slice(0, 2000),
    transcript: transcriptLines(p.transcript),
    durationSec: Number.isFinite(duration) ? Math.round(duration) : undefined,
    endedAt: new Date(),
    unrecognised,
    direction: direction === 'inbound' || direction === 'outbound' ? direction : undefined,
    agentId: p.agentId != null ? String(p.agentId) : undefined,
    fromNumber: p.fromNumber ?? p.from_number,
    toNumber: p.toNumber ?? p.to_number,
    raw: unrecognised ? p : undefined,
  };
}

/** Webhook signatures are accepted for this long after their timestamp. */
const SIGNATURE_MAX_AGE_S = 10 * 60;

/**
 * Checks `X-SnapServe-Signature: sha256=<hex>`: an HMAC-SHA256 with the signing
 * secret over "{timestamp}.{rawBody}" (event subscriptions) or the raw body alone.
 */
export function validSnapServeSignature(rawBody: Buffer | undefined, signature: string | undefined, timestamp: string | undefined, secret: string): boolean {
  if (!rawBody || !signature) return false;
  const presented = Buffer.from(signature.replace(/^sha256=/i, '').trim(), 'hex');
  if (timestamp && Math.abs(Date.now() / 1000 - Number(timestamp)) > SIGNATURE_MAX_AGE_S) return false;
  const payloads = timestamp ? [Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]), rawBody] : [rawBody];
  return payloads.some((payload) => {
    const expected = createHmac('sha256', secret).update(payload).digest();
    return expected.length === presented.length && timingSafeEqual(expected, presented);
  });
}
