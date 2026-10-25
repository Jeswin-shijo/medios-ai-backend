import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { validateEnv } from './env.validation';

const base = { JWT_SECRET: 'x'.repeat(40) };

describe('validateEnv (AI)', () => {
  test('the base config passes', () => {
    assert.doesNotThrow(() => validateEnv({ ...base }));
  });
  test('rejects an unknown AI_PROVIDER', () => {
    assert.throws(() => validateEnv({ ...base, AI_PROVIDER: 'gpt' }), /AI_PROVIDER must be none, sample or claude/);
  });
  test('claude needs an API key', () => {
    assert.throws(() => validateEnv({ ...base, AI_PROVIDER: 'claude' }), /ANTHROPIC_API_KEY is required/);
  });
  test('rejects a bad AI_TIMEOUT_MS', () => {
    assert.throws(() => validateEnv({ ...base, AI_TIMEOUT_MS: 'abc' }), /AI_TIMEOUT_MS/);
    assert.throws(() => validateEnv({ ...base, AI_TIMEOUT_MS: '0' }), /AI_TIMEOUT_MS/);
  });
  test('claude with a key passes', () => {
    assert.doesNotThrow(() => validateEnv({ ...base, AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'k' }));
  });
});
