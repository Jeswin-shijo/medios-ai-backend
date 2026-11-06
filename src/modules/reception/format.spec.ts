import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatOpNumber, formatTokenLabel, last10, maskPhone, newSecret, paymentCode, sha256 } from './format';

test('last10 keeps the last ten digits of any phone format', () => {
  for (const p of ['+91 98765 43210', '098765 43210', '91-9876543210', '9876543210']) {
    assert.equal(last10(p), '9876543210');
  }
  assert.equal(last10('12345'), '');
});

test('maskPhone hides all but the last five digits', () => {
  assert.equal(maskPhone('+91 98765 43210'), '••••• 43210');
  assert.equal(maskPhone(''), '');
});

test('formatOpNumber builds OP-YYYYMMDD-NNNN', () => {
  assert.equal(formatOpNumber('2026-09-26', 42), 'OP-20260926-0042');
  assert.equal(formatOpNumber('2026-09-26', 12345), 'OP-20260926-12345');
});

test('formatTokenLabel pads to three digits and keeps longer numbers', () => {
  assert.equal(formatTokenLabel('G', 24), 'G-024');
  assert.equal(formatTokenLabel('G2', 7), 'G2-007');
  assert.equal(formatTokenLabel('G', 1000), 'G-1000');
});

test('paymentCode is four digits; newSecret is 32 url-safe characters and unique', () => {
  assert.match(paymentCode(), /^\d{4}$/);
  const a = newSecret();
  assert.match(a, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(a, newSecret());
});

test('sha256 returns hex', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
