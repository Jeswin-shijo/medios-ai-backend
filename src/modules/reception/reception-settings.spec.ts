import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_RECEPTION_SETTINGS, resolveReceptionSettings } from './reception-settings';

describe('resolveReceptionSettings', () => {
  test('empty input gives the defaults', () => {
    assert.deepEqual(resolveReceptionSettings({}), DEFAULT_RECEPTION_SETTINGS);
    assert.deepEqual(resolveReceptionSettings(null), DEFAULT_RECEPTION_SETTINGS);
  });

  test('idleSeconds is clamped to 30-300', () => {
    assert.equal(resolveReceptionSettings({ idleSeconds: 5 }).idleSeconds, 30);
    assert.equal(resolveReceptionSettings({ idleSeconds: 9999 }).idleSeconds, 300);
    assert.equal(resolveReceptionSettings({ idleSeconds: 'x' }).idleSeconds, 60);
  });

  test('trackingBaseUrl keeps only http(s) addresses, without a trailing slash', () => {
    assert.equal(resolveReceptionSettings({ trackingBaseUrl: 'javascript:alert(1)' }).trackingBaseUrl, '');
    assert.equal(resolveReceptionSettings({ trackingBaseUrl: 'https://medi-os-ai.vercel.app/' }).trackingBaseUrl, 'https://medi-os-ai.vercel.app');
  });

  test('methods accept only real booleans', () => {
    const r = resolveReceptionSettings({ methods: { upi: false, cash: 'no', card: 0 } });
    assert.deepEqual(r.methods, { upi: false, cash: true, card: true });
  });

  test('strings are trimmed and capped at 200 characters', () => {
    const r = resolveReceptionSettings({ upiPayeeName: `  ${'a'.repeat(300)}  ` });
    assert.equal(r.upiPayeeName.length, 200);
  });
});
