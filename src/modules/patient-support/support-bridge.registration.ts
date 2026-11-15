import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ErVisitsService } from '../er/er-visits.service';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { CallTicketInput, ExpectedArrivalInput, SupportBridge } from '../support-bridge/support-bridge';
import { OWNER_LABEL, SUPPORT_ACTOR, TICKET_TYPES, TicketType } from './support-catalogue';
import { SupportTextsService } from './support-texts.service';
import { SupportTicketsService } from './support-tickets.service';

/** What the phone agent says when the ER cannot be told (the same offer Calls uses when it has no handler). */
const OFFER_CALLBACK = 'Something went wrong on our side. Apologise and offer a call back from the front desk (request_callback).';
const ARRIVED = 'The ER has been told you are coming. Please come straight to the ER entrance.';

/**
 * Gives the phone agents their Patient Support handlers (through the global bridge, so Calls never imports this module).
 * Calls keeps its own behaviour for any handler that is not registered.
 */
@Injectable()
export class SupportBridgeRegistration implements OnModuleInit {
  private readonly logger = new Logger(SupportBridgeRegistration.name);

  constructor(
    private readonly bridge: SupportBridge,
    private readonly tickets: SupportTicketsService,
    private readonly texts: SupportTextsService,
    private readonly erVisits: ErVisitsService,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>
  ) {}

  onModuleInit(): void {
    this.bridge.register({
      openCallTicket: (i) => this.openCallTicket(i),
      attachCall: (providerCallId, agentCallId) => this.tickets.attachCall(providerCallId, agentCallId),
      hospitalInfo: (topic, language) => this.texts.findFaq(topic, language),
      expectedArrival: (i) => this.expectedArrival(i)
    });
  }

  /** An emergency call is a clinical ticket; a call-back is the topic the agent gave (else other). */
  private ticketTypeOf(i: { source: CallTicketInput['source']; topic?: string }): TicketType {
    if (i.source === 'emergency-call') return 'clinical';
    return (TICKET_TYPES as readonly string[]).includes(i.topic ?? '') ? (i.topic as TicketType) : 'other';
  }

  async openCallTicket(i: CallTicketInput): Promise<{ number: string; ownerLabel: string }> {
    const patient = i.uhid ? await this.patients.findOne({ uhid: i.uhid }).select('_id').lean().exec() : null;
    const t = await this.tickets.open(SUPPORT_ACTOR, {
      patientId: patient ? String(patient._id) : undefined,
      callerName: i.callerName || 'Phone caller',
      callerPhone: (i.phone ?? '').slice(0, 20),
      ticketType: this.ticketTypeOf(i),
      question: (i.reason || 'Call-back requested').slice(0, 1000),
      urgent: i.urgent,
      source: i.source,
      providerCallId: i.providerCallId
    });
    return { number: t.number, ownerLabel: OWNER_LABEL[t.owner as keyof typeof OWNER_LABEL] ?? t.ownerLabel };
  }

  /** The ER is told first; whatever happens, an urgent clinical ticket follows so the front desk rings the caller. */
  async expectedArrival(i: ExpectedArrivalInput): Promise<{ ok: boolean; message: string }> {
    let told = true;
    try {
      await this.erVisits.addExpected(SUPPORT_ACTOR, {
        complaint: (i.complaint || 'Emergency (phone call)').slice(0, 200),
        ageSex: (i.ageSex || 'Unknown').slice(0, 40),
        mode: i.mode,
        etaMinutes: i.minutes,
        phone: i.phone
      });
    } catch (e) {
      told = false;
      this.logger.error(`The ER could not be told about an expected arrival: ${(e as Error)?.message ?? e}`);
    }
    try {
      await this.openCallTicket({
        phone: i.phone ?? '',
        uhid: i.uhid,
        reason: `Emergency call: ${i.complaint} (${i.ageSex}, ${i.mode}, in about ${i.minutes} minutes)${told ? '' : '. The ER could not be told: please ring back.'}`,
        urgent: true,
        providerCallId: i.providerCallId,
        source: 'emergency-call'
      });
    } catch (e) {
      // The ER already expects the caller, so the caller still hears that; with neither, Calls' own fallback answers.
      this.logger.error(`The ticket for an expected arrival was not opened: ${(e as Error)?.message ?? e}`);
      if (!told) throw e;
    }
    return told ? { ok: true, message: ARRIVED } : { ok: false, message: OFFER_CALLBACK };
  }
}
