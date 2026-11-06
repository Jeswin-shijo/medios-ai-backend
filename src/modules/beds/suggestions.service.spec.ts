import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AiService } from '../ai/ai.service';
import { AiProviderName, AiResult, StructuredTask } from '../ai/ai-types';
import { PatientsService } from '../patients/patients.service';
import { UserRole } from '../users/schemas/user.schema';
import { Actor } from './actor';
import { BedEvents } from './bed-events';
import { BedAiOutput } from './bed-ai-task';
import { buildBedSeed } from './bed-layout';
import { BedsService } from './beds.service';
import { SuggestInput, SuggestionsService } from './suggestions.service';

const nurse: Actor = { id: 'user-nurse', name: 'Nurse Asha', role: UserRole.NURSE };
const doctor: Actor = { id: 'user-doctor', name: 'Dr. Shajin', role: UserRole.DOCTOR };

/** Stands in for AiService: a set status and answer, and the tasks it was asked. */
function fakeAi() {
  const fake = {
    provider: 'sample' as AiProviderName,
    bedSuggestions: true,
    result: { ok: false, failure: 'off', provider: 'sample', model: 'sample', latencyMs: 0 } as AiResult<BedAiOutput>,
    tasks: [] as StructuredTask<unknown>[],
    async status() {
      return { provider: fake.provider, model: 'sample', features: { bedSuggestions: fake.bedSuggestions } };
    },
    async runStructured<T>(task: StructuredTask<T>): Promise<AiResult<T>> {
      fake.tasks.push(task);
      return fake.result as unknown as AiResult<T>;
    },
  };
  return fake;
}

/** An AI answer that puts the second rule-ranked bed first and suggests isolation. */
const aiPicksSecondBed = (): AiResult<BedAiOutput> => ({
  ok: true,
  value: {
    picks: [{ ref: 'b2', reason: 'HDU bed watches oxygen levels closely.' }],
    extraNeeds: [{ need: 'isolation', evidence: 'COPD' }],
  },
  sample: false,
  provider: 'claude',
  model: 'claude-opus-5-5',
  latencyMs: 120,
});

/** Rejects with an HTTP error of this status whose message matches. */
const rejectsHttp = (promise: Promise<unknown>, status: number, message: RegExp) =>
  assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HttpException);
    assert.equal(err.getStatus(), status);
    assert.match(err.message, message);
    return true;
  });

describe('SuggestionsService', () => {
  const { Ward, Bed, Admission, BedSuggestion, Patient, DischargeOrder } = models();
  let service: SuggestionsService;
  let ai: ReturnType<typeof fakeAi>;
  let patientId: string;
  /** Bed id by `${wardCode}-${number}`, e.g. 'PVT-3'. */
  let bedIds: Map<string, string>;

  const arun = (extra: Partial<SuggestInput> = {}): SuggestInput => ({
    patientId,
    roomClass: 'general',
    needs: ['oxygen', 'highFallRisk'],
    department: 'General Medicine',
    doctor: 'Dr. Shajin',
    expectedStayDays: 3,
    notes: 'Arun Kumar MHK202600011 COPD, SpO2 89%',
    ...extra,
  });
  const log = (id: string) => BedSuggestion.findById(id).lean().exec();

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
    const beds = await Bed.insertMany(
      seed.beds.map(({ wardCode, namedPatientUhid: _uhid, ...bed }) => ({ ...bed, ward: wardId.get(wardCode) })),
    );
    bedIds = new Map(beds.map((b, i) => [`${seed.beds[i].wardCode}-${seed.beds[i].number}`, String(b._id)]));
    const patient = await Patient.create({ uhid: 'MHK202600011', name: 'Arun Kumar', age: 68, gender: 'Male', phone: '9876543210' });
    patientId = String(patient._id);

    ai = fakeAi();
    const patients = new PatientsService(Patient);
    const bedsService = new BedsService(Ward, Bed, Admission, patients, new BedEvents(), DischargeOrder);
    service = new SuggestionsService(BedSuggestion, bedsService, patients, ai as unknown as AiService);
  });

  test('suggest returns top 3 and logs a de-identified input', async () => {
    const result = await service.suggest(nurse, arun());

    assert.equal(result.top[0].label, 'Ward A • Bed 4');
    assert.equal(result.top.length, 3);
    assert.equal(result.ai, 'pending');
    assert.deepEqual(
      result.top.map((b) => b.bedId),
      result.eligible.slice(0, 3).map((b) => b.bedId),
    );

    const stored = await log(result.suggestionId);
    const sent = JSON.stringify(stored.aiInput);
    assert.ok(!sent.includes('Arun'));
    assert.ok(!sent.includes('MHK202600011'));
    assert.ok(!sent.includes(patientId));
    for (const b of result.eligible) assert.ok(!sent.includes(b.bedId));
    assert.equal(stored.request.notes, 'Arun Kumar MHK202600011 COPD, SpO2 89%');
    assert.equal(stored.createdBy, nurse.id);
    assert.equal(stored.ai.status, 'pending');
  });

  test("AI switched off → ai 'off' and refine returns rule order with status 'off'", async () => {
    ai.bedSuggestions = false;
    const result = await service.suggest(nurse, arun());
    assert.equal(result.ai, 'off');

    const refined = await service.refine(nurse, result.suggestionId);
    assert.equal(refined.status, 'off');
    assert.equal(refined.sample, false);
    assert.deepEqual(
      refined.top.map((b) => b.bedId),
      result.top.map((b) => b.bedId),
    );
    assert.deepEqual(refined.extraNeeds, []);
    assert.equal(ai.tasks.length, 0);
  });

  test('already admitted patient is refused', async () => {
    const currentBedId = bedIds.get('GWA-1');
    await Admission.create({
      patient: patientId, patientUhid: 'MHK202600011', patientName: 'Arun Kumar', bed: currentBedId,
      roomClass: 'general', expectedStayDays: 3, status: 'active', admittedAt: new Date(), admittedBy: nurse.name,
    });

    await rejectsHttp(service.suggest(nurse, arun()), 409, /already admitted/);
    const transfer = await service.suggest(nurse, arun({ currentBedId }));
    assert.ok(transfer.top.length > 0);
    assert.ok(transfer.eligible.every((b) => b.bedId !== currentBedId));
  });

  test('no bed to offer → reserve reason shown and the AI is not asked', async () => {
    // HDU full: the only bed for a monitor is the last free ICU bed, which is kept in reserve.
    await Bed.updateMany({ _id: { $in: [bedIds.get('HDU-2'), bedIds.get('HDU-4')] } }, { state: 'occupied' }).exec();
    const result = await service.suggest(nurse, arun({ needs: ['monitor'] }));
    assert.deepEqual(result.top, []);
    assert.deepEqual(result.blockedBy, ['Last free ICU bed kept for critical patients']);
    assert.equal(result.ai, 'off');

    const refined = await service.refine(nurse, result.suggestionId);
    assert.equal(refined.status, 'off');
    assert.deepEqual(refined.top, []);
    assert.equal(ai.tasks.length, 0);
  });

  test('refine applies AI order and extra needs', async () => {
    ai.result = aiPicksSecondBed();
    const result = await service.suggest(nurse, arun());
    const { ruleRanking, aiInput } = await log(result.suggestionId);

    const refined = await service.refine(nurse, result.suggestionId);
    assert.equal(refined.status, 'ok');
    assert.equal(refined.top[0].bedId, ruleRanking[1].bedId);
    assert.equal(refined.top[0].aiReason, 'HDU bed watches oxygen levels closely.');
    assert.deepEqual(refined.extraNeeds, [{ need: 'isolation', evidence: 'COPD' }]);
    assert.deepEqual(ai.tasks[0].input, aiInput);

    const stored = await log(result.suggestionId);
    assert.equal(stored.ai.status, 'ok');
    assert.equal(stored.ai.model, 'claude-opus-5-5');
    assert.equal(stored.finalTopBedId, ruleRanking[1].bedId);

    // A second refine returns what was stored, without asking the AI again.
    assert.deepEqual(await service.refine(nurse, result.suggestionId), refined);
    assert.equal(ai.tasks.length, 1);
  });

  test('after an AI reorder, the rule top and the AI top both need no reason', async () => {
    ai.result = aiPicksSecondBed();
    const { suggestionId } = await service.suggest(nurse, arun());
    await service.refine(nurse, suggestionId);
    const { ruleRanking, finalTopBedId } = await log(suggestionId);
    const [ruleTop, aiTop, third] = ruleRanking.map((r) => r.bedId);
    assert.equal(finalTopBedId, aiTop);

    // Staff may confirm the rule top they saw before the AI answered.
    await service.authorizeChoice(suggestionId, ruleTop, nurse, {});
    await service.authorizeChoice(suggestionId, aiTop, nurse, {});
    await rejectsHttp(service.authorizeChoice(suggestionId, third, nurse, {}), 400, /not choosing the top suggestion/);

    await service.recordChoice(suggestionId, { bedId: ruleTop, admissionId: new Types.ObjectId().toString() });
    assert.equal((await log(suggestionId)).wasTopPick, true);
  });

  test('refine falls back on AI failure', async () => {
    ai.result = { ok: false, failure: 'timeout', provider: 'claude', model: 'claude-opus-5-5', latencyMs: 8000 };
    const result = await service.suggest(nurse, arun());
    const { ruleRanking } = await log(result.suggestionId);

    const refined = await service.refine(nurse, result.suggestionId);
    assert.equal(refined.status, 'timeout');
    assert.deepEqual(
      refined.top.map((b) => b.bedId),
      ruleRanking.slice(0, 3).map((r) => r.bedId),
    );
    assert.ok(refined.top.every((b) => b.aiReason === undefined));
    assert.equal((await log(result.suggestionId)).ai.status, 'timeout');
  });

  test('refine is limited to the creator and admitting staff', async () => {
    const result = await service.suggest(nurse, arun());
    const pharmacist: Actor = { id: 'user-pharmacy', name: 'Priya', role: UserRole.PHARMACIST };
    await rejectsHttp(service.refine(pharmacist, result.suggestionId), 403, /cannot use this bed suggestion/);
    assert.equal(ai.tasks.length, 0);
  });

  test('authorizeChoice rules', async () => {
    const { suggestionId, top } = await service.suggest(nurse, arun());
    const pvt3 = bedIds.get('PVT-3');

    await service.authorizeChoice(suggestionId, top[0].bedId, nurse, {});
    await rejectsHttp(service.authorizeChoice(suggestionId, top[1].bedId, nurse, {}), 400, /not choosing the top suggestion/);
    await service.authorizeChoice(suggestionId, top[1].bedId, nurse, { reason: 'Family asked for this ward' });
    await rejectsHttp(service.authorizeChoice(suggestionId, pvt3, nurse, {}), 400, /does not meet the rules/);
    await rejectsHttp(
      service.authorizeChoice(suggestionId, pvt3, nurse, { ruleOverride: true, reason: 'Private room requested' }),
      403,
      /Only a doctor or admin/,
    );
    await rejectsHttp(service.authorizeChoice(suggestionId, pvt3, doctor, { ruleOverride: true }), 400, /reason for ignoring the rules/);
    const chosen = await service.authorizeChoice(suggestionId, pvt3, doctor, { ruleOverride: true, reason: 'Portable oxygen arranged' });
    assert.equal(String(chosen._id), suggestionId);
  });

  test("patientGender is the suggestion's patient's gender", async () => {
    const { suggestionId } = await service.suggest(nurse, arun());
    assert.equal(await service.patientGender(suggestionId), 'Male');
    await rejectsHttp(service.patientGender(new Types.ObjectId().toString()), 404, /not found/);
  });

  test('recordChoice stores the outcome', async () => {
    const { suggestionId, top } = await service.suggest(nurse, arun());
    const admissionId = new Types.ObjectId().toString();

    await service.recordChoice(suggestionId, { bedId: top[0].bedId, admissionId });

    const stored = await log(suggestionId);
    assert.equal(stored.finalBedId, top[0].bedId);
    assert.equal(stored.wasTopPick, true);
    assert.equal(stored.ruleOverride, false);
    assert.ok(stored.admission instanceof Types.ObjectId);
    assert.equal(String(stored.admission), admissionId);
  });
});
