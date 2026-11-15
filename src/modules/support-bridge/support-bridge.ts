import { Injectable } from '@nestjs/common';
import type { CallOutcome } from '../calls/schemas/agent-call.schema';

// Where Calls (the phone agents) meets Patient Support without either importing the
// other. Calls uses a handler when one is registered and keeps its own behaviour when
// none is, so the call agent works exactly as before without Patient Support.
// Patient Support registers its handlers at start-up.

/** Where a call ticket came from. */
export type CallTicketSource = 'call-back' | 'call-unanswered' | 'emergency-call';

export interface CallTicketInput {
  /** E.164: the number to call back on (empty when the provider sent none). */
  phone: string;
  /** Only for a caller verified on the line. */
  uhid?: string;
  /** The verified patient's name; omitted for an unverified caller. */
  callerName?: string;
  reason: string;
  urgent: boolean;
  /** The ticket type the call agent gave (appointment, billing, … or other). */
  topic?: string;
  providerCallId?: string;
  source: CallTicketSource;
}

export interface ExpectedArrivalInput {
  complaint: string;
  ageSex: string;
  /** Whole minutes, 1 to 240. */
  minutes: number;
  mode: 'walk-in' | 'ambulance';
  /** The caller ID (E.164), when the provider sent it. */
  phone?: string;
  /** Only for a caller verified on the line. */
  uhid?: string;
  providerCallId?: string;
}

export interface CheckupCallResult {
  outcome: CallOutcome;
  /** Question key → choice key, as the agent captured them; empty when unanswered. */
  answers: Record<string, string>;
  rating?: number;
  notes?: string;
  agentCallId: string;
}

export interface SupportHandlers {
  openCallTicket(i: CallTicketInput): Promise<{ number: string; ownerLabel: string }>;
  attachCall(providerCallId: string, agentCallId: string): Promise<void>;
  hospitalInfo(topic: string, language: 'en' | 'ta'): Promise<{ found: boolean; text: string }>;
  expectedArrival(i: ExpectedArrivalInput): Promise<{ ok: boolean; message: string }>;
  checkupResult(checkupId: string, r: CheckupCallResult): Promise<void>;
}

@Injectable()
export class SupportBridge {
  handlers: Partial<SupportHandlers> = {};

  register(h: Partial<SupportHandlers>): void {
    Object.assign(this.handlers, h);
  }
}
