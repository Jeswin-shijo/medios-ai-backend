import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ConflictException, ConsoleLogger, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AiProvider } from '../ai/ai-provider';
import { AiService } from '../ai/ai.service';
import { AiProviderName, AiResult, StructuredTask } from '../ai/ai-types';
import { PatientsService } from '../patients/patients.service';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { Actor } from './actor';
import { BedAgentService } from './bed-agent.service';
import { BedAiOutput } from './bed-ai-task';
import { BedAlerts } from './bed-alerts';
import { BedEvents, BedRequestEvent } from './bed-events';
import { buildBedSeed } from './bed-layout';
import { BedRequestsService, CreateBedRequestInput } from './bed-requests.service';
import { BedsService } from './beds.service';
import { SuggestionsService } from './suggestions.service';

const DOCTOR: Actor = { id: 'user-doctor', name: 'Dr. Shajin', role: UserRole.DOCTOR };
const NURSE: Actor = { id: 'user-nurse', name: 'Nurse Asha', role: UserRole.NURSE };

/**
 * Stands in for AiService. With no `result` set it answers as sample mode does, from the
 * task's own keyword check (so "SpO₂" finds oxygen and "TB" finds isolation).
 */
function fakeAi() {
  const fake = {
    provider: 'sample' as AiProviderName,
    bedSuggestions: true,
    result: null as AiResult<BedAiOutput> | null,
    tasks: [] as StructuredTask<unknown>[],
    async status() {
      return { provider: fake.provider, model: 'sample', features: { bedSuggestions: fake.bedSuggestions } };
    },
    async runStructured<T>(task: StructuredTask<T>): Promise<AiResult<T>> {
      fake.tasks.push(task);
      if (fake.result) return fake.result as unknown as AiResult<T>;
      const value = task.validate(task.sample());
      const base = { provider: 'sample' as AiProviderName, model: 'sample', latencyMs: 0 };
      return value === null ? { ok: false, failure: 'invalid', ...base } : { ok: true, value, sample: true, ...base };
    },
  };
  return fake;
}

/** A real AI provider stand-in: `complete` is what the "model" does with the request. */
function provider(complete: AiProvider['complete']) {
  const p = { calls: 0, name: 'claude' as const, model: 'claude-opus-5-5' } as AiProvider & { calls: number };
  p.complete = (req) => {
    p.calls++;
    return complete(req);
  };
  p.check = async () => ({ ok: true, detail: 'fine' });
  return p;
}

/** Waits for a condition the agent reaches on its own (after a debounce, say). */
async function until(check: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Timed out waiting for the agent');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('BedAgentService', () => {
  const { Ward, Bed, Admission, BedSuggestion, Patient, BedRequest, TaskAlertItem, HospitalSettings } = models();
  let ai: ReturnType<typeof fakeAi>;
  let events: BedEvents;
  let seen: BedRequestEvent[];
  let patients: PatientsService;
  let beds: BedsService;
  let requests: BedRequestsService;
  let suggestions: SuggestionsService;
  let settings: SettingsService;
  let agent: BedAgentService;
  /** Bed id by `${wardCode}-${number}`, e.g. 'GWA-4'. */
  let bedIds: Map<string, string>;
  let patientCount: number;

  const bed = (code: string) => bedIds.get(code)!;
  const load = (id: string) => BedRequest.findById(id).lean().exec();
  const alertFor = (id: string) => TaskAlertItem.findOne({ link: `bed-request:${id}` }).lean().exec();
  const wardTypeOf = async (bedId: unknown) => {
    const found = await Bed.findById(bedId).lean().exec();
    return (await Ward.findById(found.ward).lean().exec()).type;
  };
  const patient = async (gender: 'Male' | 'Female' = 'Male', age = 45, name?: string) => {
    patientCount++;
    const created = await Patient.create({
      uhid: `MHK2026005${String(patientCount).padStart(2, '0')}`,
      name: name ?? `Patient ${patientCount}`,
      age,
      gender,
      phone: `90000005${String(patientCount).padStart(2, '0')}`,
    });
    return String(created._id);
  };
  /** A doctor's request for a general bed; returns its id. */
  const ask = async (over: Partial<CreateBedRequestInput> & { patientId: string }) =>
    String(
      (
        await requests.create(DOCTOR, {
          type: 'admission',
          roomClass: 'general',
          needs: [],
          notes: 'Fever for three days',
          department: 'General Medicine',
          doctor: 'Dr. Shajin',
          expectedStayDays: 3,
          priority: 'medium',
          ...over,
        })
      )._id,
    );
  /** No free bed left in the men's general ward. */
  const fillGeneralMen = async () => {
    const wardA = await Ward.findOne({ code: 'GWA' }).lean().exec();
    await Bed.updateMany({ ward: wardA._id, state: 'free' }, { state: 'occupied', occupantGender: 'Male' }).exec();
  };
  const newAgent = (parts: { ai?: AiService; beds?: BedsService } = {}) => {
    const bedsService = parts.beds ?? beds;
    const suggestionsService = parts.ai ? new SuggestionsService(BedSuggestion, bedsService, patients, parts.ai) : suggestions;
    return new BedAgentService(requests, suggestionsService, bedsService, settings, events);
  };

  before(async () => {
    await connectTestDb();
  });

  after(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    const seed = buildBedSeed();
    const wards = await Ward.insertMany(seed.wards);
    const wardId = new Map(wards.map((w) => [w.code, w._id]));
    const inserted = await Bed.insertMany(
      seed.beds.map(({ wardCode, namedPatientUhid: _uhid, ...b }) => ({ ...b, ward: wardId.get(wardCode) })),
    );
    bedIds = new Map(inserted.map((b, i) => [`${seed.beds[i].wardCode}-${seed.beds[i].number}`, String(b._id)]));
    patientCount = 0;

    ai = fakeAi();
    events = new BedEvents();
    seen = [];
    events.requests$.subscribe((e) => seen.push(e));
    patients = new PatientsService(Patient);
    beds = new BedsService(Ward, Bed, Admission, patients, events);
    requests = new BedRequestsService(BedRequest, patients, beds, new BedAlerts(TaskAlertItem), events);
    suggestions = new SuggestionsService(BedSuggestion, beds, patients, ai as unknown as AiService);
    settings = new SettingsService(HospitalSettings);
    agent = newAgent();
  });

  test("assigns the AI's first pick in the asked class and records the decision", async () => {
    const pid = await patient();
    const id = await ask({ patientId: pid });
    ai.result = {
      ok: true,
      value: { picks: [{ ref: 'b2', reason: 'Quiet end of the ward with an oxygen point.' }], extraNeeds: [] },
      sample: false,
      provider: 'claude',
      model: 'claude-opus-5-5',
      latencyMs: 90,
    };

    await agent.process(id);

    const req = await load(id);
    const log = await BedSuggestion.findById(req.decision.suggestionId).lean().exec();
    const aiPick = log.ruleRanking[1].bedId;
    assert.equal(req.state, 'assigned');
    assert.equal(req.open, false);
    assert.equal(req.lockedUntil, undefined);
    assert.equal(String(req.assignedBed), aiPick);
    assert.equal(await wardTypeOf(aiPick), 'general');
    assert.equal(req.stateReason, `Assigned to ${req.assignedBedLabel}.`);
    assert.ok(req.assignedAt instanceof Date);

    const { decision } = req;
    assert.equal(decision.by, 'ai');
    assert.equal(decision.bedId, aiPick);
    assert.equal(decision.bedLabel, req.assignedBedLabel);
    assert.equal(decision.wardName, 'General ward A (men)');
    assert.equal(decision.reason, 'Quiet end of the ward with an oxygen point.');
    assert.ok(decision.appliedRules.includes('General ward'));
    assert.deepEqual(decision.addedNeeds, []);
    assert.equal(decision.candidates.length, 5);
    assert.deepEqual(
      decision.candidates.slice(0, 2).map((c) => c.bedId),
      [aiPick, log.ruleRanking[0].bedId],
    );
    assert.equal(decision.candidates[1].reason, log.ruleRanking[0].reason);

    const admission = await Admission.findOne({ patient: pid }).lean().exec();
    assert.equal(String(admission.bed), aiPick);
    assert.equal(admission.admittedBy, 'Bed Agent');
    assert.equal(String(admission.suggestion), decision.suggestionId);
    assert.equal(String(req.admission), String(admission._id));
    const taken = await Bed.findById(aiPick).lean().exec();
    assert.equal(taken.state, 'occupied');
    assert.equal(String(taken.admission), String(admission._id));
    assert.equal(await TaskAlertItem.countDocuments(), 0);
    assert.equal(seen.at(-1)?.state, 'assigned');
  });

  test("assigns the rules' top pick when the AI times out", { timeout: 10_000 }, async () => {
    // A real AiService with a 50 ms timeout, and a model that never answers.
    const silent = provider(({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const slowAgent = newAgent({ ai: new AiService(silent, settings, { get: () => 50 } as unknown as ConfigService) });
    const id = await ask({ patientId: await patient() });

    const started = Date.now();
    await slowAgent.process(id);

    assert.ok(Date.now() - started < 5000, 'the pass did not stall on the AI');
    assert.equal(silent.calls, 1);
    const req = await load(id);
    const log = await BedSuggestion.findById(req.decision.suggestionId).lean().exec();
    assert.equal(log.ai.status, 'timeout');
    assert.equal(req.state, 'assigned');
    assert.equal(req.attempts, 0);
    assert.equal(String(req.assignedBed), log.ruleRanking[0].bedId);
    assert.equal(req.decision.by, 'rules');
    assert.equal(req.decision.reason, log.ruleRanking[0].reason);
  });

  test("assigns the rules' top pick when the AI answers badly", async () => {
    // Picks a bed that is not a candidate and a need the notes never mention.
    const wrong = provider(async () => ({ picks: [{ ref: 'b9', reason: 'Best bed' }], extraNeeds: [{ need: 'isolation', evidence: 'TB' }] }));
    const id = await ask({ patientId: await patient() });

    await newAgent({ ai: new AiService(wrong, settings, { get: () => 50 } as unknown as ConfigService) }).process(id);

    const req = await load(id);
    const log = await BedSuggestion.findById(req.decision.suggestionId).lean().exec();
    assert.equal(log.ai.status, 'invalid');
    assert.equal(req.state, 'assigned');
    assert.deepEqual(req.pendingNeeds, []);
    assert.equal(String(req.assignedBed), log.ruleRanking[0].bedId);
    assert.equal(req.decision.by, 'rules');
  });

  test('adds oxygen from the notes by itself and assigns an oxygen bed', async () => {
    // Ward A Bed 4 loses its oxygen point. Near the nurses, it ranks first for a 75-year-old
    // until oxygen is known; then only Ward A Bed 8 has oxygen (an HDU step-up is never taken).
    await Bed.updateOne({ _id: bed('GWA-4') }, { features: ['nearNurses'] }).exec();
    const pid = await patient('Male', 75);
    const id = await ask({ patientId: pid, notes: 'Breathless at rest, SpO₂ 90% on room air' });

    await agent.process(id);

    const req = await load(id);
    assert.equal(req.state, 'assigned');
    assert.deepEqual(req.needs, ['oxygen']);
    assert.deepEqual(req.addedNeeds, [{ need: 'oxygen', evidence: 'SpO₂' }]);
    assert.deepEqual(req.decision.addedNeeds, [{ need: 'oxygen', evidence: 'SpO₂' }]);
    assert.ok(req.decision.appliedRules.includes('Oxygen needed'));
    assert.equal(String(req.assignedBed), bed('GWA-8'));
    assert.ok((await Bed.findById(req.assignedBed).lean().exec()).features.includes('oxygen'));
    assert.ok(seen.some((e) => e.id === id && e.state === 'searching' && e.reason === 'Added oxygen: notes mention “SpO₂”.'));

    // Ranked twice: first without oxygen, then once more with it.
    const logs = await BedSuggestion.find({ patient: pid }).sort({ _id: 1 }).lean().exec();
    assert.equal(logs.length, 2);
    assert.equal(logs[0].ruleRanking[0].bedId, bed('GWA-4'));
    assert.deepEqual(logs[1].request.needs, ['oxygen']);
    assert.equal(logs[1].ruleRanking[0].stepUp, true);
  });

  test('holds a request that mentions TB for a doctor to confirm, and finishes after confirm', async () => {
    const pid = await patient('Male', 50, 'Suresh P');
    const id = await ask({ patientId: pid, notes: 'Cough for three weeks, suspected TB' });

    await agent.process(id);

    let req = await load(id);
    assert.equal(req.state, 'attention');
    assert.equal(req.stateReason, 'Notes mention “TB”. Confirm isolation for Suresh P?');
    assert.deepEqual(req.pendingNeeds, [{ need: 'isolation', evidence: 'TB' }]);
    assert.deepEqual(req.needs, []);
    assert.equal(req.assignedBed, undefined);
    assert.equal(await Admission.countDocuments({ patient: pid }), 0);
    const alert = await alertFor(id);
    assert.equal(alert.status, 'Pending');
    assert.equal(alert.subtitle, 'Notes mention “TB”. Confirm isolation for Suresh P?');

    await assert.rejects(agent.resolveNotesNeed(NURSE, id, 'isolation', true), ForbiddenException);
    await assert.rejects(agent.resolveNotesNeed(DOCTOR, id, 'ventilator', true), ConflictException);

    await agent.resolveNotesNeed(DOCTOR, id, 'isolation', true);
    await agent.idle();

    req = await load(id);
    assert.equal(req.state, 'assigned');
    assert.deepEqual(req.needs, ['isolation']);
    assert.deepEqual(req.pendingNeeds, []);
    assert.deepEqual(req.dismissedNeeds, []);
    assert.equal(await wardTypeOf(req.assignedBed), 'isolation');
    assert.ok(seen.some((e) => e.id === id && e.reason === 'Dr. Shajin confirmed isolation. Bed Agent is looking for a bed.'));
    assert.equal((await alertFor(id)).status, 'Completed');
    await assert.rejects(agent.resolveNotesNeed(DOCTOR, id, 'isolation', true), ConflictException);
  });

  test('a dismissed need from the notes is not asked again, and the ticked needs are used', async () => {
    const id = await ask({ patientId: await patient(), notes: 'No TB contact. Fever for three days' });
    await agent.process(id);
    assert.equal((await load(id)).state, 'attention');

    await agent.resolveNotesNeed(DOCTOR, id, 'isolation', false);
    await agent.idle();

    const req = await load(id);
    assert.equal(req.state, 'assigned');
    assert.deepEqual(req.needs, []);
    assert.deepEqual(req.dismissedNeeds, ['isolation']);
    assert.equal(await wardTypeOf(req.assignedBed), 'general');
  });

  test('waits with the nearest option named when the asked class is full; assigns when a bed frees', async () => {
    await fillGeneralMen();
    const pid = await patient('Male', 45, 'Ravi K');
    const id = await ask({ patientId: pid });

    await agent.process(id);

    let req = await load(id);
    assert.equal(req.state, 'waiting');
    assert.equal(req.stateReason, 'No General ward beds free. Twin room available, ₹700 more a day');
    assert.equal(await Admission.countDocuments({ patient: pid }), 0);
    const alert = await alertFor(id);
    assert.equal(alert.title, `No bed for Ravi K (${req.patientUhid})`);
    assert.equal(alert.status, 'Pending');

    await beds.markCleaned(bed('GWA-9'), NURSE);
    await agent.retryWaiting();
    await agent.idle();

    req = await load(id);
    assert.equal(req.state, 'assigned');
    assert.equal(String(req.assignedBed), bed('GWA-9'));
    assert.equal((await alertFor(id)).status, 'Completed');
  });

  test('goes to attention for isolation with a ventilator', async () => {
    const id = await ask({ patientId: await patient(), needs: ['isolation', 'ventilator'] });

    await agent.process(id);

    const req = await load(id);
    assert.equal(req.state, 'attention');
    assert.equal(req.stateReason, 'No bed meets all of: Isolation room, ICU bed with a ventilator');
    assert.equal(req.assignedBed, undefined);
    assert.equal(ai.tasks.length, 0);
    assert.equal((await alertFor(id)).title, `Bed request needs attention: ${req.patientName} (${req.patientUhid})`);
  });

  test('goes to attention when automatic allocation is off', async () => {
    assert.equal((await settings.getSettings()).ai.bedAutoAllocate, true);
    await settings.updateSettings({ ai: { bedAutoAllocate: false } });
    const id = await ask({ patientId: await patient() });

    await agent.process(id);

    const req = await load(id);
    assert.equal(req.state, 'attention');
    assert.equal(req.stateReason, 'Automatic allocation is off. Assign a bed by hand.');
    assert.equal(await BedSuggestion.countDocuments(), 0);
    assert.equal(await Admission.countDocuments(), 0);
    assert.equal((await alertFor(id)).status, 'Pending');
  });

  test('two requests and one free bed: one assigned, one waiting', { timeout: 10_000 }, async () => {
    // Ward A keeps one free bed. Two agents (two API instances, say) take one request each,
    // and both reach the bed before either has it.
    const last = bed('GWA-4');
    const wardA = await Ward.findOne({ code: 'GWA' }).lean().exec();
    await Bed.updateMany({ ward: wardA._id, state: 'free', _id: { $ne: last } }, { state: 'occupied', occupantGender: 'Male' }).exec();

    class RacingBeds extends BedsService {
      tries: string[] = [];
      private bothThere!: () => void;
      private readonly gate = new Promise<void>((resolve) => (this.bothThere = resolve));
      async admitToFreeBed(...args: Parameters<BedsService['admitToFreeBed']>) {
        this.tries.push(args[0]);
        if (this.tries.length === 2) this.bothThere();
        await this.gate;
        return super.admitToFreeBed(...args);
      }
    }
    const racing = new RacingBeds(Ward, Bed, Admission, patients, events);
    const [one, two] = [newAgent({ beds: racing }), newAgent({ beds: racing })];
    const [first, second] = [await ask({ patientId: await patient() }), await ask({ patientId: await patient() })];

    await Promise.all([one.process(first), two.process(second)]);

    assert.deepEqual(racing.tries, [last, last]);
    const results = [await load(first), await load(second)];
    assert.deepEqual(results.map((r) => r.state).sort(), ['assigned', 'waiting']);
    const winner = results.find((r) => r.state === 'assigned');
    const loser = results.find((r) => r.state === 'waiting');
    assert.equal(String(winner.assignedBed), last);
    assert.equal(loser.assignedBed, undefined);
    assert.equal(loser.stateReason, 'The free beds were just taken. Trying again.');
    assert.equal(loser.attempts, 0);
    assert.equal(loser.lockedUntil, undefined);
    assert.equal(await Admission.countDocuments(), 1);
    const taken = await Bed.findById(last).lean().exec();
    assert.equal(String(taken.admission), String(winner.admission));
  });

  test('a freed bed goes to the highest priority, then the oldest; a cancelled request gets nothing', async () => {
    await fillGeneralMen();
    const low = await ask({ patientId: await patient(), priority: 'low' });
    const highOlder = await ask({ patientId: await patient(), priority: 'high' });
    const highNewer = await ask({ patientId: await patient(), priority: 'high' });
    const criticalPatient = await patient();
    const critical = await ask({ patientId: criticalPatient, priority: 'critical' });
    for (const id of [low, highOlder, highNewer, critical]) agent.submit(id);
    await agent.idle();
    const states = async () => Promise.all([low, highOlder, highNewer, critical].map(async (id) => (await load(id)).state));
    assert.deepEqual(await states(), ['waiting', 'waiting', 'waiting', 'waiting']);

    await requests.cancel(DOCTOR, critical);

    // One bed frees: the older high-priority request gets it.
    await beds.markCleaned(bed('GWA-9'), NURSE);
    await agent.retryWaiting();
    await agent.idle();
    assert.deepEqual(await states(), ['waiting', 'assigned', 'waiting', 'cancelled']);
    assert.equal(String((await load(highOlder)).assignedBed), bed('GWA-9'));

    // Another frees: the newer high-priority request, still ahead of the older low one.
    await beds.unblock(bed('GWA-17'), NURSE);
    await agent.retryWaiting();
    await agent.idle();
    assert.deepEqual(await states(), ['waiting', 'assigned', 'assigned', 'cancelled']);
    assert.equal(String((await load(highNewer)).assignedBed), bed('GWA-17'));

    // Even when asked directly, the agent leaves a cancelled request alone.
    await agent.process(critical);
    const cancelled = await load(critical);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.assignedBed, undefined);
    assert.equal(await Admission.countDocuments({ patient: criticalPatient }), 0);
  });

  test('recover processes a searching request whose lock expired, exactly once', async () => {
    const ranked: string[] = [];
    const rank = suggestions.rankForAgent.bind(suggestions);
    suggestions.rankForAgent = (actor, dto) => {
      ranked.push(dto.patientId);
      return rank(actor, dto);
    };
    // A pass that died with the API: still searching, its lock run out.
    const stalePatient = await patient();
    const stale = await ask({ patientId: stalePatient });
    await BedRequest.updateOne({ _id: stale }, { lockedUntil: new Date(Date.now() - 1000) }).exec();
    // A pass another API instance is running now.
    const busyPatient = await patient();
    const busy = await ask({ patientId: busyPatient });
    const busyUntil = new Date(Date.now() + 60_000);
    await BedRequest.updateOne({ _id: busy }, { lockedUntil: busyUntil }).exec();
    // And a request that was waiting when the API stopped.
    const waitingPatient = await patient();
    const waiting = await ask({ patientId: waitingPatient });
    await requests.toState(waiting, 'waiting', 'No general bed is free.');

    await Promise.all([agent.recover(), agent.recover()]);
    await agent.idle();

    assert.equal((await load(stale)).state, 'assigned');
    assert.equal(ranked.filter((p) => p === stalePatient).length, 1);
    assert.equal(await Admission.countDocuments({ patient: stalePatient }), 1);
    assert.equal((await load(waiting)).state, 'assigned');
    assert.equal(ranked.filter((p) => p === waitingPatient).length, 1);
    const untouched = await load(busy);
    assert.equal(untouched.state, 'searching');
    assert.equal(untouched.lockedUntil.getTime(), busyUntil.getTime());
    assert.equal(ranked.includes(busyPatient), false);
  });

  test('a transfer request moves the patient and marks a step-down', async () => {
    const pid = await patient();
    const hdu = bed('HDU-2');
    const admission = await beds.admitToFreeBed(hdu, DOCTOR, {
      patientId: pid, doctor: 'Dr. Shajin', department: 'Cardiology', roomClass: 'hdu', needs: ['monitor'], notes: 'Chest pain', expectedStayDays: 4,
    });
    const id = await ask({ type: 'transfer', patientId: pid, fromBedId: hdu, notes: 'Stable for two days' });

    await agent.process(id);

    const req = await load(id);
    assert.equal(req.state, 'assigned');
    assert.equal(req.type, 'transfer');
    assert.equal(req.stepDown, true);
    assert.equal(await wardTypeOf(req.assignedBed), 'general');
    const moved = await Admission.findById(admission._id).lean().exec();
    assert.equal(String(moved.bed), String(req.assignedBed));
    assert.equal(moved.transfers.length, 1);
    assert.equal(String(moved.transfers[0].fromBed), hdu);
    assert.equal(moved.transfers[0].by, 'Bed Agent');
    assert.equal(moved.transfers[0].reason, 'Step-down requested by Dr. Shajin');
    assert.equal(await Admission.countDocuments(), 1);
    assert.equal((await Bed.findById(hdu).lean().exec()).state, 'cleaning');
    assert.equal(String(req.admission), String(admission._id));
  });

  test('unexpected errors are retried, and the third one goes to attention', async () => {
    class BrokenBeds extends BedsService {
      async admitToFreeBed(): Promise<never> {
        throw new Error('Database unavailable');
      }
    }
    const broken = newAgent({ beds: new BrokenBeds(Ward, Bed, Admission, patients, events) });
    const id = await ask({ patientId: await patient() });

    Logger.overrideLogger(false);
    try {
      for (const attempts of [1, 2]) {
        await broken.process(id);
        const req = await load(id);
        assert.equal(req.state, 'waiting');
        assert.equal(req.attempts, attempts);
        assert.equal(req.stateReason, 'Something went wrong while assigning a bed. Trying again.');
        assert.equal(req.lockedUntil, undefined);
      }
      await broken.process(id);
    } finally {
      Logger.overrideLogger(new ConsoleLogger());
    }

    const req = await load(id);
    assert.equal(req.state, 'attention');
    assert.equal(req.attempts, 3);
    assert.equal(req.stateReason, 'Something went wrong while assigning a bed. Assign one by hand.');
    assert.equal(req.lockedUntil, undefined);
    // Attention waits for staff: the agent does not retry it.
    await agent.retryWaiting();
    await agent.process(id);
    assert.equal((await load(id)).state, 'attention');
    assert.equal(await Admission.countDocuments(), 0);
  });

  test('assigning by hand closes the request with a staff decision', async () => {
    await fillGeneralMen();
    const pid = await patient();
    const id = await ask({ patientId: pid });
    await agent.process(id);
    const admission = await beds.admitToFreeBed(bed('TWN-2'), DOCTOR, {
      patientId: pid, doctor: 'Dr. Shajin', department: 'General Medicine', roomClass: 'twin', needs: [], notes: '', expectedStayDays: 3,
    });
    const byHand = {
      bedId: bed('TWN-2'), bedLabel: 'Twin 1 • Bed B', wardName: 'Twin-sharing rooms', admissionId: String(admission._id),
      actor: DOCTOR, reason: 'Family agreed to the twin room', suggestionId: 'suggestion-1',
    };

    await agent.completeByHand(id, byHand);

    const req = await load(id);
    assert.equal(req.state, 'assigned');
    assert.equal(req.closedByName, 'Dr. Shajin');
    assert.equal(req.assignedBedLabel, 'Twin 1 • Bed B');
    assert.equal(String(req.admission), String(admission._id));
    assert.equal(req.decision.by, 'staff');
    assert.equal(req.decision.reason, 'Family agreed to the twin room');
    assert.equal((await alertFor(id)).status, 'Completed');

    // A request closed meanwhile is left as it is.
    const other = await ask({ patientId: await patient() });
    await requests.cancel(DOCTOR, other);
    await agent.completeByHand(other, byHand);
    assert.equal((await load(other)).state, 'cancelled');
  });

  test('a bed change wakes the agent for waiting requests, until the module stops', { timeout: 10_000 }, async () => {
    await fillGeneralMen();
    const id = await ask({ patientId: await patient() });
    await agent.process(id);
    assert.equal((await load(id)).state, 'waiting');
    let retries = 0;
    const retry = agent.retryWaiting.bind(agent);
    agent.retryWaiting = () => {
      retries++;
      return retry();
    };

    agent.onModuleInit();
    try {
      await beds.markCleaned(bed('GWA-9'), NURSE);
      await until(async () => (await load(id)).state === 'assigned');
    } finally {
      agent.onModuleDestroy();
    }
    await agent.idle();
    assert.equal(String((await load(id)).assignedBed), bed('GWA-9'));

    const before = retries;
    events.changed();
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(retries, before);
  });
});
