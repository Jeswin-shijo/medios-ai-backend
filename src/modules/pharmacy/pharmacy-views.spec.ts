import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { Flag } from './pharmacy-rules';
import { flagView } from './pharmacy-views';

const flag = (version: number): Flag =>
  ({
    key: 'allergy.penicillin',
    kind: 'allergy',
    severity: 'red',
    text: 'Penicillin allergy',
    version,
    confirmed: { by: 'Dr Shajin', reason: 'Tolerated before', at: new Date('2026-09-26T10:00:00Z') },
    reviewed: { by: 'Neethu George', at: new Date('2026-09-26T10:05:00Z') },
  }) as unknown as Flag;

describe('flagView and the line version', () => {
  test('a confirmation or review from an older version of the line shows as null', () => {
    const v = flagView(flag(1), 2);
    assert.equal(v.confirmed, null);
    assert.equal(v.reviewed, null);
  });
  test('one that belongs to the current version is shown', () => {
    const v = flagView(flag(2), 2);
    assert.equal(v.confirmed?.reason, 'Tolerated before');
    assert.equal(v.reviewed?.by, 'Neethu George');
  });
});
