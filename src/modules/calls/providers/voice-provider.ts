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
}

export type CallResultHandler = (result: CallResult) => Promise<unknown>;

export interface VoiceProvider {
  readonly name: 'none' | 'simulated' | 'snapserve';
  /** True when calls reach real phones. */
  readonly live: boolean;
  startCall(request: StartCallRequest): Promise<{ providerCallId: string }>;
  /** Providers without a webhook deliver results through this handler. */
  attachResultHandler?(handler: CallResultHandler): void;
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
