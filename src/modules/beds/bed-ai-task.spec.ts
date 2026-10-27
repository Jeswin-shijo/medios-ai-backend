import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inventoryFromSeed } from '../../test/bed-fixtures';
import {
  BedAiInput,
  buildBedAiInput,
  bedAiTask,
  mergePicks,
  sampleBedAiOutput,
  validateBedAiOutput,
} from './bed-ai-task';
import { AdmissionRequestInput } from './bed-types';
import { applyRules } from './rules';
import { rankBeds } from './scoring';

const NOW = new Date('2026-09-26T10:00:00');
const { wards, beds } = inventoryFromSeed(NOW);
const who = { name: 'Arun Kumar', uhid: 'MHK202600011', phone: '9876543210' };

const arunReq = (notes = 'Arun Kumar is breathless'): AdmissionRequestInput => ({
  age: 68,
  gender: 'Male',
  roomClass: 'general',
  needs: ['oxygen', 'highFallRisk'],
  department: 'General Medicine',
  expectedStayDays: 3,
  notes,
});

function build(notes?: string) {
  const req = arunReq(notes);
  const { ranked } = rankBeds(req, applyRules(req, wards, beds, NOW), wards, beds, NOW);
  return { ranked, ...buildBedAiInput({ req, who, ranked, wards, beds }) };
}

function walk(node: unknown, visit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (node && typeof node === 'object') {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((n) => walk(n, visit));
  }
}

describe('bed AI task', () => {
  test('input has ≤5 candidates with refs b1..b5 and no identifiers', () => {
    const { ranked, input, refs } = build();
    assert.ok(input.candidates.length <= 5);
    assert.deepEqual(Object.keys(refs), ['b1', 'b2', 'b3', 'b4', 'b5'].slice(0, input.candidates.length));
    assert.equal(refs.b1, ranked[0].bedId);
    const json = JSON.stringify(input);
    for (const s of ['Arun', 'MHK202600011', 'GWA-4']) assert.ok(!json.includes(s), s);
    assert.ok(!input.possibleExtraNeeds.includes('oxygen'));
    assert.ok(input.possibleExtraNeeds.includes('isolation'));
  });

  test('schema is strict and has no length keywords', () => {
    const { input, refs } = build();
    const task = bedAiTask(input);
    walk(task.schema, (o) => {
      if (o.type === 'object') assert.equal(o.additionalProperties, false);
      for (const k of ['minLength', 'maxLength', 'maxItems']) assert.ok(!(k in o), k);
    });
    const picks = (task.schema.properties as any).picks.items.properties.ref.enum;
    assert.deepEqual(picks, Object.keys(refs));
  });

  test('validate drops unknown/duplicate refs, caps 3, truncates reasons', () => {
    const { input } = build();
    const long = 'word '.repeat(40);
    const out = validateBedAiOutput(
      {
        extraNeeds: [],
        picks: ['b2', 'b9', 'b2', 'b1', 'b3', 'b4'].map((ref) => ({ ref, reason: long })),
      },
      input,
    );
    assert.ok(out);
    assert.deepEqual(out.picks.map((p) => p.ref), ['b2', 'b1', 'b3']);
    for (const p of out.picks) {
      assert.ok(p.reason.length <= 140);
      assert.ok(p.reason.endsWith('…'));
    }
  });

  test('validate drops extra needs without evidence in notes', () => {
    const picks = [{ ref: 'b1', reason: 'ok' }];
    const withTb = build('suspected TB').input;
    const kept = validateBedAiOutput({ picks, extraNeeds: [{ need: 'isolation', evidence: 'TB' }] }, withTb);
    assert.deepEqual(kept?.extraNeeds, [{ need: 'isolation', evidence: 'TB' }]);
    const without = build('cough').input;
    assert.deepEqual(
      validateBedAiOutput({ picks, extraNeeds: [{ need: 'isolation', evidence: 'TB' }] }, without)?.extraNeeds,
      [],
    );
    // already ticked
    assert.deepEqual(
      validateBedAiOutput({ picks, extraNeeds: [{ need: 'oxygen', evidence: 'TB' }] }, withTb)?.extraNeeds,
      [],
    );
  });

  test('validate returns null for no picks or bad shape', () => {
    const { input } = build();
    assert.equal(validateBedAiOutput({ extraNeeds: [], picks: [{ ref: 'b9', reason: 'x' }] }, input), null);
    assert.equal(validateBedAiOutput({ extraNeeds: [], picks: [] }, input), null);
    assert.equal(validateBedAiOutput({ picks: [] }, input), null);
    assert.equal(validateBedAiOutput('nope', input), null);
    assert.equal(validateBedAiOutput(null, input), null);
  });

  test('sample suggests isolation for TB', () => {
    const { input } = build('suspected TB, cough 3 weeks');
    const out = sampleBedAiOutput(input);
    assert.deepEqual(out.extraNeeds, [{ need: 'isolation', evidence: 'TB' }]);
    assert.deepEqual(out.picks.map((p) => p.ref), ['b1', 'b2', 'b3']);
    for (const p of out.picks) assert.ok(p.reason.length <= 140 && p.reason.endsWith('.'));
    assert.ok(bedAiTask(input).validate(out));
  });

  test('sample reasons read as sentences, without price or floor numbers', () => {
    const { input } = build();
    const out = sampleBedAiOutput(input);
    assert.equal(out.picks[0].reason, "Near the nurses' station, oxygen point and near General Medicine.");
    assert.equal(out.picks[1].reason, "Near the nurses' station, ground floor, oxygen point and closer monitoring (HDU).");
    for (const p of out.picks) assert.ok(!/₹|\/day|floor \d/i.test(p.reason), p.reason);
  });

  test('sample reason for a bed with no rule reasons', () => {
    const { input } = build();
    const bare: BedAiInput = { ...input, candidates: [{ ...input.candidates[0], ruleReasons: [] }] };
    assert.equal(sampleBedAiOutput(bare).picks[0].reason, 'Free now and matches the requested ward.');
  });

  test('sample matches SpO₂ and skips needs already ticked', () => {
    const base = build('SpO₂ 89% on air, fall last week').input;
    const input: BedAiInput = { ...base, possibleExtraNeeds: [...base.possibleExtraNeeds, 'oxygen'] };
    const out = sampleBedAiOutput(input);
    assert.ok(out.extraNeeds.some((e) => e.need === 'oxygen' && e.evidence === 'SpO₂'));
    // highFallRisk is ticked in the request, so not suggested
    assert.ok(!sampleBedAiOutput(base).extraNeeds.some((e) => e.need === 'highFallRisk'));
  });

  test('mergePicks applies AI order and fills to 3', () => {
    const { ranked, refs } = build();
    const merged = mergePicks(ranked, { extraNeeds: [], picks: [{ ref: 'b3', reason: 'because' }] }, refs);
    assert.deepEqual(merged.map((m) => m.bedId), [ranked[2].bedId, ranked[0].bedId, ranked[1].bedId]);
    assert.equal(merged[0].aiReason, 'because');
    assert.equal(merged[1].aiReason, undefined);
    assert.equal(merged[2].aiReason, undefined);
    assert.deepEqual(mergePicks(ranked, null, refs).map((m) => m.bedId), ranked.slice(0, 3).map((r) => r.bedId));
    assert.equal(mergePicks(ranked.slice(0, 2), null, refs).length, 2);
  });

  test('mergePicks with a limit returns the AI picks first, then the rest of the rule order', () => {
    const ranked = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'].map((bedId) => ({ bedId, score: 0, reasons: [], reason: '', stepUp: false }));
    const lookup = { a: 'r4', b: 'r1' };
    const merged = mergePicks(ranked, { extraNeeds: [], picks: [{ ref: 'a', reason: 'x' }, { ref: 'b', reason: 'y' }] }, lookup, ranked.length);
    assert.deepEqual(merged.map((m) => m.bedId), ['r4', 'r1', 'r0', 'r2', 'r3', 'r5']);
  });
});
