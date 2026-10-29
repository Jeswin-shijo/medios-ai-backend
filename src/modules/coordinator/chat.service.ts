import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { StructuredTask } from '../ai/ai-types';
import { AiService } from '../ai/ai.service';
import { Actor } from '../beds/actor';
import { PatientsService } from '../patients/patients.service';
import { AgentRegistry } from './agent-registry';
import { AgentStatusService } from './agent-status.service';
import { ApprovalsService } from './approvals.service';
import { CasesService } from './cases.service';
import { ChatIntent, ChatIntentKind, resolveQuestion } from './chat-intent';
import { ClocksService } from './clocks.service';
import { AGENTS } from './coordinator-types';
import { ChatLog, ChatLogDocument } from './schemas/chat-log.schema';
import { CaseDocument } from './schemas/case.schema';
import { Escalation, EscalationDocument } from './schemas/escalation.schema';

export interface ChatAction {
  kind: 'open';
  screen: 'bed-request-form' | 'case' | 'bed-agent-request';
  params: Record<string, string>;
}

export interface ChatAnswer {
  answer: string;
  sample: boolean;
  action?: ChatAction;
}

export const MAX_ANSWER_LENGTH = 280;
const MINUTE_MS = 60_000;
const DUE_SOON_MS = 15 * MINUTE_MS;

export const UNKNOWN_ANSWER =
  "I can answer questions about cases, bed requests, agents and approvals. Try: 'Where is the bed request for MHK202500323?', 'Show agent workload', 'Pending approvals'.";

const INSTRUCTIONS = [
  'You reword a short answer for hospital staff in plain English.',
  'You get a de-identified template and the facts behind it. Reword the template only.',
  'Keep the phrases "the patient" and "the case" exactly as they are; never replace them with a name or number.',
  `Stay at or under ${MAX_ANSWER_LENGTH} characters.`,
  'Add no facts that are not in the template or the facts.',
  'Do not give medical advice.',
].join(' ');

/** The AI only rewords: it sees the intent, de-identified facts and the template, never the question. */
function chatTask(kind: ChatIntentKind, facts: Record<string, unknown>, template: string): StructuredTask<{ answer: string }> {
  return {
    feature: 'coordinatorChat',
    instructions: INSTRUCTIONS,
    input: { intent: kind, facts, template },
    schema: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } },
    validate: (raw) => {
      const answer = (raw as { answer?: unknown } | null)?.answer;
      return typeof answer === 'string' && answer.trim() !== '' && answer.length <= MAX_ANSWER_LENGTH ? { answer } : null;
    },
    sample: () => ({ answer: template }),
  };
}

interface PatientRef {
  id: string;
  name: string;
  uhid: string;
}

/** What a question turned into before any AI wording. `patient` and `case` are only used to fill the display. */
interface Draft {
  template: string;
  facts: Record<string, unknown>;
  useAi: boolean;
  patient?: PatientRef;
  case?: { id: string; number: string };
  action?: ChatAction;
  /** Added to the shown answer after the AI. Used for example UHIDs, which must never reach it. */
  suffix?: string;
}

type Lookup =
  | { found: true; patient: PatientRef; case: CaseDocument | null }
  | { found: false; reply: string };

/** Shows the first few of a list and "and N more", so a fallback template stays short. */
const joinMax = (items: string[], max = 3, sep = ', ') =>
  items.length <= max ? items.join(sep) : `${items.slice(0, max).join(sep)} and ${items.length - max} more`;
const clamp = (text: string) => (text.length <= MAX_ANSWER_LENGTH ? text : `${text.slice(0, MAX_ANSWER_LENGTH - 3).trimEnd()}...`);
const plain = (template: string, extra: Partial<Draft> = {}): Draft => ({ template, facts: {}, useAi: false, ...extra });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const minutesBetween = (later: Date | string | number, earlier: Date | string | number) => Math.round((new Date(later).getTime() - new Date(earlier).getTime()) / MINUTE_MS);

/** The Ask box: answers and suggests, never acts. */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectModel(ChatLog.name) private readonly logs: Model<ChatLogDocument>,
    @InjectModel(Escalation.name) private readonly escalationModel: Model<EscalationDocument>,
    private readonly cases: CasesService,
    private readonly clocks: ClocksService,
    private readonly approvals: ApprovalsService,
    private readonly agentStatus: AgentStatusService,
    private readonly patients: PatientsService,
    private readonly ai: AiService,
    private readonly registry: AgentRegistry,
  ) {}

  async ask(actor: Actor, question: string): Promise<ChatAnswer> {
    const asked = typeof question === 'string' ? question : '';
    let intent: ChatIntent = { kind: 'unknown' };
    let draft: Draft;
    try {
      intent = resolveQuestion(asked);
      draft = await this.draft(intent);
    } catch (e) {
      this.logger.error(`Answering a question failed: ${(e as Error).message}`);
      draft = plain('Something went wrong while looking that up. Please try again.');
    }

    let text = draft.template;
    let sample = false;
    let aiInput: Record<string, unknown> | null = null;
    if (draft.useAi) {
      const task = chatTask(intent.kind, draft.facts, draft.template);
      aiInput = { instructions: task.instructions, input: task.input };
      try {
        const result = await this.ai.runStructured(task);
        // Off means nothing was sent, so there is nothing to record.
        if ('failure' in result && result.failure === 'off') aiInput = null;
        if ('value' in result) {
          text = result.value.answer;
          sample = result.sample;
        }
      } catch (e) {
        this.logger.warn(`AI wording failed, using the template: ${(e as Error).message}`);
      }
    }

    const answer = this.display(text, draft);
    try {
      await this.logs.create({ user: actor.id, userName: actor.name, question: asked, intent, answer, aiInput, sample });
    } catch (e) {
      this.logger.error(`Logging a question failed: ${(e as Error).message}`);
    }
    return { answer, sample, ...(draft.action ? { action: draft.action } : {}) };
  }

  /** Puts the name, UHID and case number in after the AI, so they never go to it. */
  private display(text: string, d: Draft): string {
    let out = text;
    let named = false;
    if (d.patient) {
      const who = `${d.patient.name} (${d.patient.uhid})`;
      if (/\bthe patient\b/i.test(out)) {
        out = out.replace(/\bthe patient\b/i, () => who);
        named = true;
      }
    }
    if (d.case) out = out.replace(/\bthe case\b/i, () => d.case!.number);
    if (d.patient && !named) out = `${d.patient.name} (${d.patient.uhid}): ${out}`;
    return d.suffix ? `${out}${d.suffix}` : out;
  }

  private async draft(intent: ChatIntent): Promise<Draft> {
    switch (intent.kind) {
      case 'unknown':
        return plain(UNKNOWN_ANSWER);
      case 'agent-workload':
        return this.workload();
      case 'approvals':
        return this.openApprovals();
      case 'overdue':
        return this.overdue();
      case 'allocate-bed':
        return this.allocateBed(intent);
      case 'discharge-status':
        return this.discharge(intent);
      default:
        return this.caseStatus(intent);
    }
  }

  /** Finds the patient (and their case) a question names. */
  private async lookup(ref: NonNullable<ChatIntent['ref']>): Promise<Lookup> {
    if (ref.kind === 'case') {
      const c = await this.cases.byNumber(ref.value);
      if (!c) return { found: false, reply: `I couldn't find ${ref.value}.` };
      return { found: true, patient: { id: String(c.patient), name: c.patientName, uhid: c.patientUhid }, case: c };
    }
    let doc;
    if (ref.kind === 'uhid') {
      try {
        doc = await this.patients.findOne(ref.value);
      } catch (e) {
        if (!(e instanceof NotFoundException)) throw e;
        return { found: false, reply: `I couldn't find a patient matching '${ref.value}'.` };
      }
    } else {
      const { patients, total } = await this.patients.findAll({ search: ref.value, limit: 3 });
      if (patients.length === 0) return { found: false, reply: `I couldn't find a patient matching '${ref.value}'.` };
      if (patients.length > 1) return { found: false, reply: `I found ${total} patients matching '${ref.value}'. Use the UHID.` };
      doc = patients[0] as any;
    }
    const patient = { id: String(doc._id), name: doc.name as string, uhid: doc.uhid as string };
    return { found: true, patient, case: await this.cases.forPatient(patient.id) };
  }

  private async caseStatus(intent: ChatIntent): Promise<Draft> {
    if (!intent.ref) return plain("Tell me which patient, for example: 'Where is the bed request for MHK202500323?'");
    const found = await this.lookup(intent.ref);
    if ('reply' in found) return plain(found.reply);
    if (!found.case) return plain('There is no case for the patient.', { patient: found.patient });
    const c = found.case;
    const caseId = String(c._id);

    const now = Date.now();
    const running = (await this.clocks.list({ state: 'running', case: caseId })).map((k) => ({
      label: this.registry.clock(k.def)?.label ?? k.def,
      minutesLeft: Math.max(0, Math.ceil((new Date(k.dueAt).getTime() - now) / MINUTE_MS)),
    }));
    const timeline = await this.cases.timeline(caseId);
    const last = timeline[timeline.length - 1];
    const facts = {
      kind: c.kind,
      priority: c.priority,
      state: c.state,
      agents: [...c.agents],
      clocks: running,
      lastEvent: last ? { type: last.type, minutesAgo: Math.max(0, minutesBetween(now, last.createdAt)) } : null,
    };

    const agentNames = c.agents.map((k) => `${AGENTS.find((a) => a.key === k)?.name ?? k} Agent`);
    let template = `The case for the patient is ${c.state} (${c.kind === 'ipd' ? 'IPD' : 'ER'}, ${c.priority} priority).`;
    if (agentNames.length) template += ` ${agentNames.join(', ')} ${agentNames.length === 1 ? 'is' : 'are'} involved.`;
    if (running.length) template += ` ${joinMax(running.map((r) => `${r.label} has ${r.minutesLeft} min left`), 3, '; ')}.`;
    if (last) {
      const what = this.registry.messageType(last.type)?.description ?? last.type;
      template += ` Last update: ${what}, ${facts.lastEvent!.minutesAgo} min ago.`;
    }
    return {
      template: clamp(template),
      facts,
      useAi: true,
      patient: found.patient,
      case: { id: caseId, number: c.number },
      action: { kind: 'open', screen: 'case', params: { caseId } },
    };
  }

  private async allocateBed(intent: ChatIntent): Promise<Draft> {
    if (!intent.ref) return plain("Tell me which patient to allocate a bed for, for example: 'Allocate bed for MHK202500323'.");
    const found = await this.lookup(intent.ref);
    if ('reply' in found) return plain(found.reply);
    // Only suggests: opens the form, so a person decides and submits it.
    return plain('Open the bed request form for the patient.', {
      patient: found.patient,
      action: { kind: 'open', screen: 'bed-request-form', params: { patientId: found.patient.id, uhid: found.patient.uhid } },
    });
  }

  private async discharge(intent: ChatIntent): Promise<Draft> {
    if (!intent.ref) {
      const open = await this.cases.countOpen('ipd');
      const template = `The Discharge Agent arrives in a later phase. There ${open === 1 ? 'is' : 'are'} ${plural(open, 'patient')} with an open inpatient case. Ask about one patient by UHID.`;
      // The example is added after the AI: an example UHID must never be part of what it is sent.
      return { template, facts: { openInpatientCases: open, dischargeAgentBuilt: false }, useAi: true, suffix: " For example: 'Discharge status for MHK202500323'." };
    }
    const found = await this.lookup(intent.ref);
    if ('reply' in found) return plain(found.reply);
    if (!found.case) return plain('There is no case for the patient.', { patient: found.patient });
    const c = found.case;
    const admissionLinked = !!c.refs?.admissionId;
    const template = `The case for the patient is ${c.state}. ${admissionLinked ? 'An admission is linked.' : 'No admission is linked.'} The Discharge Agent arrives in a later phase.`;
    return {
      template,
      facts: { caseState: c.state, admissionLinked },
      useAi: true,
      patient: found.patient,
      case: { id: String(c._id), number: c.number },
      action: { kind: 'open', screen: 'case', params: { caseId: String(c._id) } },
    };
  }

  private workload(): Draft {
    const all = this.agentStatus.list();
    const built = all.filter((a) => a.built).map((a) => ({ agent: a.key, online: a.online, open: a.open, capacity: a.capacity }));
    const notBuilt = all.length - built.length;
    const lines = built.map((a) => {
      const name = AGENTS.find((x) => x.key === a.agent)?.name ?? a.agent;
      return `${name} is ${a.online ? 'online' : 'offline'} with ${a.open} of ${a.capacity} open`;
    });
    const template = clamp(`${lines.length ? `${joinMax(lines, 3, '. ')}. ` : 'No agents are built yet. '}${plural(notBuilt, 'agent')} ${notBuilt === 1 ? 'is' : 'are'} not built yet.`);
    return { template, facts: { built, notBuilt }, useAi: true };
  }

  private async openApprovals(): Promise<Draft> {
    const open = await this.approvals.list({ state: 'open', limit: 200 });
    const groups = new Map<string, number>();
    for (const a of open) groups.set(`${a.agent}|${a.type}`, (groups.get(`${a.agent}|${a.type}`) ?? 0) + 1);
    const byType = [...groups].map(([key, count]) => {
      const [agent, type] = key.split('|');
      return { agent, type, count };
    });
    if (!open.length) return { template: 'There are no open approvals.', facts: { open: 0, byType: [] }, useAi: true };
    const parts = byType.map((g) => `${g.count} ${g.type} from ${AGENTS.find((a) => a.key === g.agent)?.name ?? g.agent}`);
    const template = clamp(`There ${open.length === 1 ? 'is' : 'are'} ${plural(open.length, 'open approval')}: ${joinMax(parts)}.`);
    return { template, facts: { open: open.length, byType }, useAi: true };
  }

  private async overdue(): Promise<Draft> {
    const label = (def: string) => this.registry.clock(def)?.label ?? def;
    const tally = (labels: string[]) => {
      const counts = new Map<string, number>();
      for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
      return [...counts].map(([l, count]) => ({ label: l, count }));
    };
    const expired = (await this.clocks.list({ state: 'expired', limit: 200 })).filter((k) => k.escalation);
    const openEsc = new Set(
      (await this.escalationModel.find({ _id: { $in: expired.map((k) => k.escalation) }, state: 'open' }).select('_id').lean().exec()).map((e) => String(e._id)),
    );
    const overdue = tally(expired.filter((k) => openEsc.has(k.escalation as string)).map((k) => label(k.def)));
    const now = Date.now();
    const soon = tally(
      (await this.clocks.list({ state: 'running', limit: 200 })).filter((k) => new Date(k.dueAt).getTime() - now <= DUE_SOON_MS).map((k) => label(k.def)),
    );
    const list = (rows: { label: string; count: number }[]) => joinMax(rows.map((r) => `${r.label} (${r.count})`));
    const total = (rows: { count: number }[]) => rows.reduce((n, r) => n + r.count, 0);
    const parts: string[] = [];
    if (overdue.length) parts.push(`${plural(total(overdue), 'item')} overdue with an open escalation: ${list(overdue)}.`);
    if (soon.length) parts.push(`${plural(total(soon), 'item')} due within 15 minutes: ${list(soon)}.`);
    const template = parts.length ? clamp(parts.join(' ')) : 'Nothing is overdue, and nothing is due in the next 15 minutes.';
    return { template, facts: { overdue, dueSoon: soon }, useAi: true };
  }
}
