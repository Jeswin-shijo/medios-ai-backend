import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { untilNextSnapshot } from './bed-agent.scheduler';

const HOUR_MS = 3_600_000;

describe('untilNextSnapshot', () => {
  test('waits for the next full hour plus a 1 s margin', () => {
    const hour = Date.UTC(2026, 9, 28, 9);
    assert.equal(untilNextSnapshot(hour + 59 * 60_000), 60_000 + 1000);
    assert.equal(untilNextSnapshot(hour + 1), HOUR_MS - 1 + 1000);
    // Exactly on the hour (the boot snapshot just took this one): the next hour.
    assert.equal(untilNextSnapshot(hour), HOUR_MS + 1000);
  });
});
