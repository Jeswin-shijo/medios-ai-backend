import { ServiceUnavailableException } from '@nestjs/common';
import { CallOutcome, CallPurpose } from '../schemas/agent-call.schema';
import { SimulatedResponse } from '../call-agent-settings';

// A voice provider runs the live conversation (speech-to-text, LLM, voice). The API
// asks it to start a call and later receives one normalized result per call: through
// the provider's webhook (SnapServe) or directly (the simulator).

export const VOICE_PROVIDER = Symbol('VOICE_PROVIDER');

export interface StartCallRequest {
  /** Our AgentCall id; also sent to the agent as the `call_ref` variable. */
  callId: string;
  purpose: CallPurpose;
  /** E.164. */
  toNumber: string;
  variables: Record<string, string>;
  /** Only the simulator reads this. */
  simulation: SimulatedResponse;
}

export interface CallResult {
  /** Our id, when the provider echoes it back. */
  callId?: string;
  providerCallId?: string;
  outcome: CallOutcome;
  chosenSlot?: number;
  callbackAt?: Date;
  notes?: string;
  summary: string;
  transcript: { speaker: 'agent' | 'patient'; text: string }[];
  durationSec?: number;
  endedAt?: Date;
  /** Set when the provider's outcome label was not recognised. */
  unrecognised?: string;
  /** Calls we did not place (a patient phoning the hospital) are identified by these. */
  direction?: 'inbound' | 'outbound';
  agentId?: string;
  fromNumber?: string;
  toNumber?: string;
  /** The provider's payload, kept when its outcome was not understood. */
  raw?: Record<string, unknown>;
}

/** What a provider connection check found (API key, agents, balance), for staff. */
export interface ProviderCheck {
  provider: string;
  ok: boolean;
  agents: { role: string; agentId: string; ok: boolean; name?: string; active?: boolean; detail: string }[];
  wallet?: { ok: boolean; balanceInr?: number; detail: string };
  detail?: string;
}

export type CallResultHandler = (result: CallResult) => Promise<unknown>;

export interface VoiceProvider {
  readonly name: 'none' | 'simulated' | 'snapserve';
  /** True when calls reach real phones. */
  readonly live: boolean;
  startCall(request: StartCallRequest): Promise<{ providerCallId: string }>;
  /** Providers without a webhook deliver results through this handler. */
  attachResultHandler?(handler: CallResultHandler): void;
  /** Checks the credentials and agents without placing a call. */
  check?(): Promise<ProviderCheck>;
}

/** A provider-side refusal or outage; the message is shown to staff as is. */
export class ProviderError extends Error {}

export class NoCallProvider implements VoiceProvider {
  readonly name = 'none';
  readonly live = false;

  async startCall(): Promise<{ providerCallId: string }> {
    throw new ServiceUnavailableException('No call provider is configured. Set CALL_PROVIDER (see the backend README).');
  }
}
