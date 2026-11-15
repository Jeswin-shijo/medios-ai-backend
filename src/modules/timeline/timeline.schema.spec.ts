import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';

describe('TimelineEvent schema', () => {
  const m = models();
  before(connectTestDb);
  after(closeTestDb);
  beforeEach(resetTestDb);

  test('a timeline event can use the Communication category', async () => {
    const e = await m.TimelineEvent.create({ uhid: 'MHK202600001', date: '2026-09-26', time: '10:00', category: 'Communication', title: 'Family update sent' });
    assert.equal(e.category, 'Communication');
    await assert.rejects(m.TimelineEvent.create({ uhid: 'MHK202600001', date: '2026-09-26', time: '10:00', category: 'Nonsense', title: 'x' }));
  });
});
