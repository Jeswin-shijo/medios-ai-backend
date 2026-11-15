import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/** Loads configuration.ts fresh, because it reads NODE_ENV and the environment when the module loads. */
function load(env: Record<string, string | undefined>): any {
  const keys = ['NODE_ENV', 'MESSAGE_PROVIDER', 'SNAPSERVE_CHECKUP_AGENT_ID'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    for (const k of keys) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    const path = require.resolve('./configuration');
    delete require.cache[path];
    return require('./configuration').default();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve('./configuration')];
  }
}

describe('configuration (Patient Support)', () => {
  test('MESSAGE_PROVIDER defaults to sample outside production and none in production', () => {
    assert.equal(load({ NODE_ENV: 'development' }).support.messageProvider, 'sample');
    assert.equal(load({ NODE_ENV: 'production' }).support.messageProvider, 'none');
    assert.equal(load({ NODE_ENV: 'production', MESSAGE_PROVIDER: 'Sample' }).support.messageProvider, 'sample');
  });

  test('SNAPSERVE_CHECKUP_AGENT_ID is optional and read beside the other agent ids', () => {
    assert.equal(load({}).callAgent.snapserve.checkupAgentId, '');
    assert.equal(load({ SNAPSERVE_CHECKUP_AGENT_ID: '1999' }).callAgent.snapserve.checkupAgentId, '1999');
  });
});
