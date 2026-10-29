import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_CALL_AGENT_SETTINGS, resolveCallAgentSettings } from './call-agent-settings';

describe('resolveCallAgentSettings', () => {
  test('garbage falls back to the defaults', () => {
    assert.deepEqual(resolveCallAgentSettings(undefined), DEFAULT_CALL_AGENT_SETTINGS);
    assert.deepEqual(resolveCallAgentSettings('nonsense'), DEFAULT_CALL_AGENT_SETTINGS);
    const s = resolveCallAgentSettings({ maxAttempts: 99, retryMinutes: 'x', callingHoursStart: '21:00', callingHoursEnd: '08:00', closedDays: ['Sun', 'Funday'] });
    assert.equal(s.maxAttempts, 5);
    assert.equal(s.retryMinutes, DEFAULT_CALL_AGENT_SETTINGS.retryMinutes);
    assert.equal(s.callingHoursStart, '09:00', 'a start after the end resets both');
    assert.deepEqual(s.closedDays, ['Sun']);
  });

  test('changes by phone stay on unless switched off explicitly', () => {
    assert.equal(resolveCallAgentSettings({}).inboundChanges, true);
    assert.equal(resolveCallAgentSettings({ inboundChanges: 'false' }).inboundChanges, true);
    assert.equal(resolveCallAgentSettings({ inboundChanges: false }).inboundChanges, false);
  });

  test('the public address: https only, without trailing slashes or a trailing /api', () => {
    const url = (publicApiUrl: unknown) => resolveCallAgentSettings({ publicApiUrl }).publicApiUrl;
    assert.equal(url('https://medios.example.com'), 'https://medios.example.com');
    assert.equal(url(' https://medios.example.com/ '), 'https://medios.example.com');
    assert.equal(url('https://medios-api.onrender.com/api'), 'https://medios-api.onrender.com');
    assert.equal(url('https://medios-api.onrender.com/api/'), 'https://medios-api.onrender.com');
    assert.equal(url('https://example.com/medios/api//'), 'https://example.com/medios');
    assert.equal(url('https://example.com/apis'), 'https://example.com/apis', 'only a whole /api segment');
    assert.equal(url('http://localhost:4000'), '');
    assert.equal(url('https://example.com/?token=x'), '');
    assert.equal(url('ftp://example.com'), '');
    assert.equal(url(42), '');
  });
});
