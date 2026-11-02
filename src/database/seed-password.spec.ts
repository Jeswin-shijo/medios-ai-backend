import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isLocalMongoUri, resolveDemoPassword } from './seed-password';

describe('seed demo password', () => {
  test('local databases may use the published password', () => {
    assert.equal(resolveDemoPassword({ MONGODB_URI: 'mongodb://localhost:27017/x' }), 'Admin@123');
    assert.equal(resolveDemoPassword({ MONGODB_URI: 'mongodb://127.0.0.1/x' }), 'Admin@123');
    assert.equal(resolveDemoPassword({}), 'Admin@123');
  });
  test('a remote database refuses without SEED_DEMO_PASSWORD', () => {
    const uri = 'mongodb+srv://u:p@medios-demo.0lmgakc.mongodb.net/medios_demo';
    assert.equal(isLocalMongoUri(uri), false);
    assert.throws(() => resolveDemoPassword({ MONGODB_URI: uri }), /SEED_DEMO_PASSWORD/);
    assert.throws(() => resolveDemoPassword({ MONGODB_URI: 'mongodb://localhost.evil.com/x' }), /SEED_DEMO_PASSWORD/);
  });
  test('SEED_DEMO_PASSWORD wins anywhere', () => {
    assert.equal(resolveDemoPassword({ MONGODB_URI: 'mongodb+srv://u:p@h.net/x', SEED_DEMO_PASSWORD: 'Private#1pass' }), 'Private#1pass');
    assert.equal(resolveDemoPassword({ MONGODB_URI: 'mongodb://localhost/x', SEED_DEMO_PASSWORD: 'Private#1pass' }), 'Private#1pass');
  });
});
