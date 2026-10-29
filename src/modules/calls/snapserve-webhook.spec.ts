import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createHmac } from 'node:crypto';
import { parseSnapServeResult, validSnapServeSignature } from './providers/snapserve.provider';

const SECRET = 'test-signing-secret-0123456789';
const sign = (payload: string) => `sha256=${createHmac('sha256', SECRET).update(payload).digest('hex')}`;
const now = () => String(Math.floor(Date.now() / 1000));

describe('validSnapServeSignature', () => {
  const body = '{"id":"call_1","dispositionResult":{"outcome":"Booked"}}';
  const raw = Buffer.from(body);

  test('without a timestamp: an HMAC of the raw body', () => {
    assert.equal(validSnapServeSignature(raw, sign(body), undefined, SECRET), true);
    assert.equal(validSnapServeSignature(Buffer.from(`${body} `), sign(body), undefined, SECRET), false, 'a changed body');
    assert.equal(validSnapServeSignature(raw, sign(body), undefined, 'another-secret-0123456789'), false);
  });

  test('with a timestamp: only an HMAC of "{timestamp}.{body}" is accepted', () => {
    const ts = now();
    assert.equal(validSnapServeSignature(raw, sign(`${ts}.${body}`), ts, SECRET), true);
    assert.equal(validSnapServeSignature(raw, sign(body), ts, SECRET), false, 'a body-only signature would let a fresh timestamp be replayed');
  });

  test('a stale or non-numeric timestamp is refused', () => {
    const stale = String(Math.floor(Date.now() / 1000) - 11 * 60);
    assert.equal(validSnapServeSignature(raw, sign(`${stale}.${body}`), stale, SECRET), false);
    assert.equal(validSnapServeSignature(raw, sign(`abc.${body}`), 'abc', SECRET), false);
    assert.equal(validSnapServeSignature(raw, sign(`.${body}`), ' ', SECRET), false);
  });

  test('a signature of the wrong length, or none, is refused without throwing', () => {
    assert.equal(validSnapServeSignature(raw, 'sha256=abcd', undefined, SECRET), false);
    assert.equal(validSnapServeSignature(raw, 'not-hex', undefined, SECRET), false);
    assert.equal(validSnapServeSignature(raw, undefined, undefined, SECRET), false);
    assert.equal(validSnapServeSignature(undefined, sign(body), undefined, SECRET), false);
  });
});

describe('parseSnapServeResult', () => {
  test('post-call notify: the call object with dispositionResult fields', () => {
    const r = parseSnapServeResult({
      id: 4521,
      status: 'completed',
      durationSeconds: 95.4,
      callSummary: 'Booked a visit.',
      transcript: [
        { role: 'assistant', content: 'Hello, this is Asha.' },
        { role: 'user', content: 'Hi.' },
      ],
      dispositionResult: { 'Chosen slot': '2', outcome: 'Booked', notes: 'Prefers mornings' },
      variables: { call_ref: '64b000000000000000000001' },
    });
    assert.equal(r.outcome, 'booked');
    assert.equal(r.chosenSlot, 2);
    assert.equal(r.notes, 'Prefers mornings');
    assert.equal(r.durationSec, 95);
    assert.equal(r.callId, '64b000000000000000000001');
    assert.equal(r.providerCallId, 4521);
    assert.deepEqual(
      r.transcript.map((l) => l.speaker),
      ['agent', 'patient'],
    );
    assert.equal(r.raw, undefined, 'the payload is kept only when the outcome is not understood');
  });

  test('an event subscription wraps the call in data; inbound calls carry direction and agent', () => {
    const r = parseSnapServeResult({
      event: 'call.completed',
      timestamp: 1790000000,
      data: { callId: 'c-9', direction: 'INBOUND', agentId: 1542, fromNumber: '+919876543210', dispositionResult: { outcome: 'Needs staff' } },
    });
    assert.equal(r.outcome, 'escalated');
    assert.equal(r.direction, 'inbound');
    assert.equal(r.agentId, '1542');
    assert.equal(r.fromNumber, '+919876543210');
    assert.equal(r.providerCallId, 'c-9');
  });

  test('unanswered statuses, a reschedule without a slot, and an unknown outcome', () => {
    assert.equal(parseSnapServeResult({ id: 1, status: 'no-pickup' }).outcome, 'no_answer');
    assert.equal(parseSnapServeResult({ id: 2, dispositionResult: { outcome: 'Reschedule' } }).outcome, 'reschedule_requested');
    const odd = parseSnapServeResult({ id: 3, dispositionResult: { outcome: 'Sang a song' } });
    assert.equal(odd.outcome, 'failed');
    assert.equal(odd.unrecognised, 'Sang a song');
    assert.ok(odd.raw, 'kept to check the mapping');
  });
});
