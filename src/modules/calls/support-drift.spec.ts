import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CHECKUP_QUESTIONS, questionsFor, TICKET_TYPES } from '../patient-support/support-catalogue';
import { AGENT_SCRIPTS } from './agent-scripts';
import { CALL_BACK_TOPICS } from './inbound.service';
import { SimulatedProvider } from './providers/simulated.provider';

// Calls keeps its own copies of Patient Support's lists (the phone scripts and the simulator never import it). These
// guards fail as soon as a copy drifts from the catalogue.
describe("Calls' copies of Patient Support's lists", () => {
  const script = AGENT_SCRIPTS.checkup.instructions;
  /** The script's lines for one numbered question, up to the next one. */
  const section = (key: string) => {
    const from = script.search(new RegExp(`^\\d+\\. (?:\\(cardiac\\) )?${key}:`, 'm'));
    assert.ok(from >= 0, `the script asks ${key}`);
    const rest = script.slice(from + 1);
    const next = rest.search(/^\d+\. |^\s*$/m);
    return script.slice(from, next < 0 ? undefined : from + 1 + next);
  };

  test('the check-up script asks the same questions, in the same order, with the same choice keys and emergencies', () => {
    const asked = [...script.matchAll(/^\d+\. (\(cardiac\) )?([a-z]+):/gm)].map((m) => [m[2], !!m[1]]);
    assert.deepEqual(
      asked,
      CHECKUP_QUESTIONS.map((q) => [q.key, !q.groups.includes('general')])
    );
    for (const q of CHECKUP_QUESTIONS.filter((x) => x.key !== 'rating')) {
      const lines = section(q.key);
      assert.ok(lines.includes(`"${q.en}"`), `${q.key}: the question text`);
      const choices = [...lines.matchAll(/(?:^|;)\s*([a-z]+) - /gm)].map((m) => m[1]);
      assert.deepEqual(
        choices,
        q.choices.map((c) => c.key),
        `${q.key}: the choice keys`
      );
      const emergencies = [...lines.matchAll(/(?:^|;)\s*([a-z]+) - [^;]*\(EMERGENCY\)/gm)].map((m) => m[1]);
      assert.deepEqual(
        emergencies,
        q.choices.filter((c) => c.level === 'emergency').map((c) => c.key),
        `${q.key}: the emergency choices`
      );
    }
  });

  test('the simulator answers exactly the questions of each list, each with a choice that is all well', () => {
    const sim = new SimulatedProvider(0) as unknown as { checkup(v: Record<string, string>): { answers: Record<string, string>; rating: number } };
    for (const group of ['general', 'cardiac'] as const) {
      const r = sim.checkup({ patient_name: 'Test Patient', question_list: group, language: 'en' });
      const questions = questionsFor(group).filter((q) => q.key !== 'rating');
      assert.deepEqual(
        Object.keys(r.answers),
        questions.map((q) => q.key),
        group
      );
      for (const q of questions) assert.equal(q.choices.find((c) => c.key === r.answers[q.key])?.level, 'ok', `${group}: ${q.key}`);
      assert.ok(Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5);
    }
  });

  test("the call-back topics are Patient Support's ticket types", () => {
    assert.deepEqual([...CALL_BACK_TOPICS], [...TICKET_TYPES]);
  });
});
