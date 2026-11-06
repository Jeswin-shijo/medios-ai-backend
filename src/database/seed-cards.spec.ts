import * as assert from 'node:assert/strict';
import { describe, test, before, beforeEach, after } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../test/test-db';
import { DEMO_CARDS, seedDemoCards } from './seed-cards';

describe('seedDemoCards', () => {
  const m = () => models();
  const card = async (cardId: string) => (await m().PatientCard.findOne({ cardId }).lean()) as any;

  before(connectTestDb);
  after(closeTestDb);
  beforeEach(resetTestDb);

  test('a fresh database gets the demo cards, each active', async () => {
    await seedDemoCards(m().PatientCard);
    const all = (await m().PatientCard.find().lean()) as any[];
    assert.deepEqual(all.map((c) => c.cardId).sort(), DEMO_CARDS.map((c) => c.cardId).sort());
    for (const c of all) {
      assert.equal(c.status, 'active');
      assert.equal(c.linkedBy, 'Seed');
      assert.ok(c.linkedAt instanceof Date);
    }
  });

  test("a reseed makes each demo card its patient's one active card again", async () => {
    const rekha = DEMO_CARDS[0];
    const earlier = new Date(Date.now() - 60_000);
    // During a demo, a new card was written for Rekha: her demo card was replaced.
    await m().PatientCard.create({ ...rekha, linkedBy: 'Seed', status: 'replaced', linkedAt: earlier, replacedAt: earlier, writtenAt: earlier } as any);
    await m().PatientCard.create({ cardId: '04E2E0C1', uhid: rekha.uhid, linkedBy: 'Desk', status: 'active', linkedAt: earlier, writtenAt: earlier } as any);
    // Rekha's demo card linked again by hand in the desk reader's decimal format, and another patient's card.
    await m().PatientCard.create({ cardId: '0077705923', uhid: rekha.uhid, linkedBy: 'Desk', status: 'active', linkedAt: earlier } as any);
    await m().PatientCard.create({ cardId: '04ABCDEF', uhid: 'MHK209900001', linkedBy: 'Desk', status: 'active', linkedAt: earlier } as any);

    await seedDemoCards(m().PatientCard);

    const demo = await card(rekha.cardId);
    assert.equal(demo.status, 'active');
    assert.equal(demo.replacedAt, undefined);
    assert.equal(demo.writtenAt, undefined);
    assert.ok(demo.linkedAt > earlier);
    const written = await card('04E2E0C1');
    assert.equal(written.status, 'replaced', 'the newer card is kept, replaced');
    assert.ok(written.replacedAt instanceof Date);
    assert.equal((await card('0077705923')).status, 'active', 'another reader format of the demo card is not another card');
    assert.equal((await card('04ABCDEF')).status, 'active', "other patients' cards are left alone");
  });
});
