import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AnthropicLike, ClaudeAiProvider } from './claude.provider';

const S = { type: 'object', properties: {}, additionalProperties: false };

function fake(reply: { stop_reason?: string; content: any[] }) {
  const calls: { body: any; options: any }[] = [];
  const create = async (body: any, options: any) => {
    calls.push({ body, options });
    return reply;
  };
  const client: AnthropicLike = {
    beta: { messages: { create } },
    models: { retrieve: async () => ({}) },
  };
  return { client, calls };
}

const req = (signal = new AbortController().signal) => ({ instructions: 'INSTR', input: { a: 1 }, schema: S, signal });
const make = (reply: Parameters<typeof fake>[0]) => {
  const f = fake(reply);
  return { ...f, provider: new ClaudeAiProvider({ apiKey: 'k', model: 'claude-opus-5-5' }, f.client) };
};

describe('ClaudeAiProvider', () => {
  test('sends model, system, schema format and low effort', async () => {
    const { provider, calls } = make({ content: [{ type: 'text', text: '{}' }] });
    const ctrl = new AbortController();
    await provider.complete(req(ctrl.signal));
    const { body, options } = calls[0];
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.system, 'INSTR');
    assert.deepEqual(body.output_config.format, { type: 'json_schema', schema: S });
    assert.equal(body.output_config.effort, 'low');
    assert.equal(body.messages[0].content, JSON.stringify({ a: 1 }));
    assert.equal(options.signal, ctrl.signal);
  });

  test('parses the text block', async () => {
    const { provider } = make({ content: [{ type: 'thinking' }, { type: 'text', text: '{"a":1}' }] });
    assert.deepEqual(await provider.complete(req()), { a: 1 });
  });

  test('a refusal throws', async () => {
    const { provider } = make({ stop_reason: 'refusal', content: [] });
    await assert.rejects(provider.complete(req()), /refusal/);
  });

  test('missing text throws', async () => {
    const { provider } = make({ content: [{ type: 'thinking' }] });
    await assert.rejects(provider.complete(req()));
  });

  test('check reports connected or the error', async () => {
    const { provider } = make({ content: [] });
    assert.deepEqual(await provider.check(), { ok: true, detail: 'Connected: claude-opus-5-5' });
    const bad = new ClaudeAiProvider({ apiKey: 'k', model: 'm' }, {
      beta: { messages: { create: async () => ({ content: [] }) } },
      models: { retrieve: async () => { throw new Error('nope'); } },
    });
    assert.deepEqual(await bad.check(), { ok: false, detail: 'nope' });
  });
});
