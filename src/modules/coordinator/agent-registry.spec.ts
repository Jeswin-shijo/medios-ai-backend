import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { AGENTS, AgentDefinition, validatePayload } from './coordinator-types';
import { AgentRegistry } from './agent-registry';

const status = async () => ({ open: 0, capacity: 0, onTimePct: null });

const bedDef = (): AgentDefinition => ({
  key: 'bed',
  messageTypes: [{ type: 'bed.waiting', agent: 'bed', description: 'No bed yet', payload: { requestId: 'string' } }],
  handles: [{ type: 'case.opened', handler: async () => undefined }],
  clocks: [{ key: 'bed-wait', agent: 'bed', label: 'Bed wait', startOn: 'bed.waiting', stopOn: ['bed.assigned', 'bed.cancelled'], minutes: 60, ladder: 'bed-wait' }],
  status,
});

describe('agent registry', () => {
  it("AGENTS lists the nine agents in the client's order", () => {
    assert.deepEqual(
      AGENTS.map((a) => a.key),
      ['coordinator', 'er', 'bed', 'lab', 'pharmacy', 'discharge', 'scheduling', 'revenue', 'patient-support'],
    );
    assert.ok(AGENTS.every((a) => a.name && a.job));
  });

  it('register refuses a duplicate agent and a message type owned by another agent', () => {
    const r = new AgentRegistry();
    r.register(bedDef());
    assert.throws(() => r.register(bedDef()), /already/i);
    assert.throws(
      () => r.register({ key: 'lab', messageTypes: [{ type: 'bed.waiting', agent: 'lab', description: 'x', payload: {} }], status }),
      /bed\.waiting/,
    );
  });

  it('subscribers and clock lookups find what agents registered', () => {
    const r = new AgentRegistry();
    r.register(bedDef());
    assert.deepEqual(r.subscribers('case.opened').map((s) => s.agent), ['bed']);
    assert.deepEqual(r.subscribers('nothing'), []);
    assert.equal(r.clocksStartingOn('bed.waiting')[0].key, 'bed-wait');
    assert.equal(r.clocksStoppingOn('bed.cancelled')[0].key, 'bed-wait');
    assert.equal(r.clocksStartingOn('bed.assigned').length, 0);
    assert.equal(r.clock('bed-wait')?.minutes, 60);
    assert.equal(r.messageType('bed.waiting')?.agent, 'bed');
    assert.equal(r.isBuilt('bed'), true);
    assert.equal(r.isBuilt('lab'), false);
  });

  it('validatePayload reports missing and wrongly typed fields and accepts a valid payload', () => {
    const def = {
      type: 't',
      agent: 'bed' as const,
      description: '',
      payload: { a: 'string', n: 'number', b: 'boolean', d: 'date', l: 'string[]', o: 'object' } as const,
    };
    const ok = { a: 'x', n: 1, b: false, d: new Date(), l: ['x'], o: {} };
    assert.deepEqual(validatePayload(def, ok), []);
    assert.deepEqual(validatePayload(def, { ...ok, d: '2026-10-29T10:00:00.000Z' }), []);
    assert.equal(validatePayload(def, undefined).length, 6);
    const errs = validatePayload(def, { ...ok, n: 'x', l: [1], a: undefined });
    assert.equal(errs.length, 3);
  });

  it('the coordinator registers its own message types', () => {
    const r = new AgentRegistry();
    assert.equal(r.isBuilt('coordinator'), true);
    for (const t of ['case.opened', 'case.closed', 'clock.expired', 'escalation.raised', 'approval.requested', 'approval.decided']) {
      assert.equal(r.messageType(t)?.agent, 'coordinator', t);
    }
  });
});
