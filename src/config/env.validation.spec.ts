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

describe('validateEnv (call agent)', () => {
  test('CALL_TOOLS_SECRET: 24+ characters when set', () => {
    assert.throws(() => validateEnv({ ...base, CALL_TOOLS_SECRET: 'short' }), /CALL_TOOLS_SECRET must be 24\+ random characters/);
    assert.doesNotThrow(() => validateEnv({ ...base, CALL_TOOLS_SECRET: 'a'.repeat(24) }));
    assert.doesNotThrow(() => validateEnv({ ...base, CALL_TOOLS_SECRET: '' }), 'empty means inbound tools are off');
  });

  test('CALL_ALLOWED_NUMBERS: Indian mobiles only, in any common shape', () => {
    assert.doesNotThrow(() => validateEnv({ ...base, CALL_ALLOWED_NUMBERS: '+91 98765 43210, 09876543211,919876543212' }));
    assert.throws(() => validateEnv({ ...base, CALL_ALLOWED_NUMBERS: '+91 98765 43210, 12345' }), /CALL_ALLOWED_NUMBERS has numbers that are not 10-digit Indian mobiles: 12345/);
    assert.throws(() => validateEnv({ ...base, CALL_ALLOWED_NUMBERS: '+44 7700 900123' }), /CALL_ALLOWED_NUMBERS/);
  });

  test('snapserve needs its key, agent ids and a webhook secret', () => {
    assert.throws(() => validateEnv({ ...base, CALL_PROVIDER: 'snapserve' }), /SNAPSERVE_API_KEY is required/);
    const snapserve = { ...base, CALL_PROVIDER: 'snapserve', SNAPSERVE_API_KEY: 'k', SNAPSERVE_CONFIRMATION_AGENT_ID: '1', SNAPSERVE_BOOKING_AGENT_ID: '2' };
    assert.throws(() => validateEnv({ ...snapserve, CALL_WEBHOOK_SECRET: 'short' }), /CALL_WEBHOOK_SECRET/);
    assert.doesNotThrow(() => validateEnv({ ...snapserve, CALL_WEBHOOK_SECRET: 'w'.repeat(24) }));
  });
});
