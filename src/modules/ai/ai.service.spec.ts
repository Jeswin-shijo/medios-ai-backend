import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AiService } from './ai.service';
import { AiProvider, AiCompletionRequest } from './ai-provider';
import { AiProviderName, AiResult, StructuredTask } from './ai-types';

const task: StructuredTask<{ ok: true }> = {
  feature: 'bedSuggestions',
  instructions: 'i',
  input: {},
  schema: {},
  validate: (raw) => ((raw as any)?.ok === true ? { ok: true } : null),
  sample: () => ({ ok: true }),
};

const settings = (on: boolean) => ({ getSettings: async () => ({ ai: { bedSuggestions: on } }) }) as any;
const config = { get: () => 50 } as any;

function provider(name: AiProviderName, complete: (req: AiCompletionRequest) => Promise<unknown>) {
  const calls: AiCompletionRequest[] = [];
  const p: AiProvider = {
    name,
    model: 'm',
    complete: (req) => {
      calls.push(req);
      return complete(req);
    },
    check: async () => ({ ok: true, detail: 'fine' }),
  };
  return { p, calls };
}

/** Asserts the result is a failure and narrows it to one. */
function failed<T>(r: AiResult<T>): Extract<AiResult<T>, { ok: false }> {
  assert.equal(r.ok, false);
  if (r.ok) throw new Error('expected a failure');
  return r;
}

const service = (p: AiProvider, on = true) => new AiService(p, settings(on), config);

describe('AiService.runStructured', () => {
  test('none gives off', async () => {
    const { p } = provider('none', async () => ({ ok: true }));
    const r = await service(p).runStructured(task);
    assert.equal(failed(r).failure, 'off');
  });

  test('setting off gives off and the provider is not called', async () => {
    const { p, calls } = provider('claude', async () => ({ ok: true }));
    const r = await service(p, false).runStructured(task);
    assert.equal(failed(r).failure, 'off');
    assert.equal(calls.length, 0);
  });

  test('sample gives ok with sample:true', async () => {
    const { p, calls } = provider('sample', async () => ({ ok: true }));
    const r = await service(p).runStructured(task);
    assert.ok(r.ok);
    assert.equal(r.ok && r.sample, true);
    assert.equal(calls.length, 0);
  });

  test('a valid answer gives ok with sample:false', async () => {
    const { p } = provider('claude', async () => ({ ok: true }));
    const r = await service(p).runStructured(task);
    assert.ok(r.ok);
    assert.equal(r.ok && r.sample, false);
  });

  test('an invalid answer gives invalid', async () => {
    const { p } = provider('claude', async () => ({ ok: false }));
    const r = await service(p).runStructured(task);
    assert.equal(failed(r).failure, 'invalid');
  });

  test('a throw gives provider_error with detail', async () => {
    const { p } = provider('claude', async () => {
      throw new Error('boom');
    });
    const r = await service(p).runStructured(task);
    assert.equal(failed(r).failure, 'provider_error');
    assert.equal(failed(r).detail, 'boom');
  });

  test('a slow provider times out and the signal is aborted', async () => {
    const { p, calls } = provider('claude', () => new Promise(() => undefined));
    const started = Date.now();
    const r = await service(p).runStructured(task);
    assert.equal(failed(r).failure, 'timeout');
    assert.ok(Date.now() - started < 200);
    assert.equal(calls[0].signal.aborted, true);
  });
});

describe('AiService.status', () => {
  test('reports provider, model and feature flags', async () => {
    const { p } = provider('claude', async () => ({}));
    assert.deepEqual(await service(p).status(), { provider: 'claude', model: 'm', features: { bedSuggestions: true } });
    assert.deepEqual((await service(p, false).status()).features, { bedSuggestions: false });
  });
});
