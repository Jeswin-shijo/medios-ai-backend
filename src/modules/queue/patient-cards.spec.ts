import * as assert from 'node:assert/strict';
import { describe, test, before, beforeEach, after } from 'node:test';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { CARD_REPLACED_MESSAGE, PatientCardsService, cardHint, cardIdCandidates } from './patient-cards.service';

/** Rejects with a 404 that says the card has been replaced, coded for the tablet. */
const replacedError = (e: unknown) => {
  assert.ok(e instanceof NotFoundException);
  assert.equal(e.message, CARD_REPLACED_MESSAGE);
  assert.equal((e.getResponse() as { code?: string }).code, 'CARD_REPLACED');
  return true;
};

describe('card lookup across reader formats', () => {
  let service: PatientCardsService;
  const m = () => models();

  before(connectTestDb);
  after(closeTestDb);
  beforeEach(async () => {
    await resetTestDb();
    // findByCard never touches the queue.
    service = new PatientCardsService(m().PatientCard, m().Patient, {} as any);
  });

  test('cardIdCandidates lists the other readers\' forms, original first', () => {
    const c = cardIdCandidates('04A1B2C3');
    assert.equal(c[0], '04A1B2C3');
    for (const want of ['C3B2A104', '77705923', '0077705923', '3283263748']) assert.ok(c.includes(want), want);
    assert.equal(new Set(c).size, c.length);
  });

  test('non-hex ids only match themselves', () => {
    assert.deepEqual(cardIdCandidates('ZZZZ9999'), ['ZZZZ9999']);
  });

  test('a decimal read also gives the hex forms, both byte orders, 4 and 7 bytes where the number fits (R33)', () => {
    const c = cardIdCandidates('0077705923');
    assert.equal(c[0], '0077705923');
    for (const want of ['04A1B2C3', 'C3B2A104', '00000004A1B2C3', 'C3B2A104000000']) assert.ok(c.includes(want), want);
    assert.equal(new Set(c).size, c.length);
    // A 7-byte UID read as one decimal number has no 4-byte form.
    const seven = cardIdCandidates(BigInt('0x04112233445566').toString());
    assert.ok(seven.includes('04112233445566') && seven.includes('66554433221104'));
    assert.ok(!seven.some((x) => x.length === 8 && /[A-F]/.test(x)));
  });

  test('every form of one card finds every other form (the candidates are symmetric)', () => {
    const forms = ['04A1B2C3', 'C3B2A104', '77705923', '0077705923', '3283263748'];
    for (const read of forms) {
      const c = cardIdCandidates(read);
      for (const linked of forms) assert.ok(c.includes(linked), `${read} finds ${linked}`);
    }
  });

  test('a card linked in hex is found by a decimal read, in either byte order', async () => {
    await m().PatientCard.create({ cardId: '04A1B2C3', uhid: 'U3', linkedBy: 't' });
    assert.equal((await service.findByCard('0077705923'))?.uhid, 'U3');
    assert.equal((await service.findByCard('3283263748'))?.uhid, 'U3');
    assert.equal(await service.findUhid('77705923'), 'U3');
  });

  test('an exact match still wins over another form', async () => {
    await m().PatientCard.create({ cardId: '0077705923', uhid: 'U1', linkedBy: 't' });
    await m().PatientCard.create({ cardId: '04A1B2C3', uhid: 'U2', linkedBy: 't' });
    assert.equal((await service.findByCard('0077705923'))?.uhid, 'U1');
    assert.equal((await service.findByCard('04A1B2C3'))?.uhid, 'U2');
  });

  test('a card linked in decimal is found by the hex read', async () => {
    await m().PatientCard.create({ cardId: '0077705923', uhid: 'U1', linkedBy: 't' });
    const card = await service.findByCard('04:a1:b2:c3');
    assert.equal(card?.uhid, 'U1');
    assert.ok(card?.lastUsedAt);
  });

  test('a card linked as little-endian decimal is found by the hex read', async () => {
    await m().PatientCard.create({ cardId: '3283263748', uhid: 'U2', linkedBy: 't' });
    assert.equal((await service.findByCard('04A1B2C3'))?.uhid, 'U2');
  });

  test('an unknown well-formed id gives null; a malformed one throws', async () => {
    assert.equal(await service.findByCard('ZZZZ9999'), null);
    await assert.rejects(() => service.findByCard('ab'), BadRequestException);
  });

  test("findUhid (the ER's card lookup) matches every reader format and leaves lastUsedAt alone", async () => {
    await m().PatientCard.create({ cardId: '0077705923', uhid: 'U1', linkedBy: 't' });
    assert.equal(await service.findUhid('04:a1:b2:c3'), 'U1');
    assert.equal(await service.findUhid('0077705923'), 'U1');
    assert.equal(((await m().PatientCard.findOne({ uhid: 'U1' }).lean()) as any).lastUsedAt, undefined);
    await assert.rejects(() => service.findUhid('ZZZZ9999'), NotFoundException);
  });

  describe('link across formats', () => {
    beforeEach(async () => {
      for (const uhid of ['U1', 'U2']) await m().Patient.create({ uhid, name: `Patient ${uhid}`, phone: '9876543210', gender: 'Male', age: 30 } as any);
      await m().PatientCard.create({ cardId: '0077705923', uhid: 'U1', linkedBy: 't' });
    });

    test('a hex link to another patient is refused', async () => {
      await assert.rejects(() => service.link('04A1B2C3', 'U2', 'tester'), ConflictException);
      assert.equal(await m().PatientCard.countDocuments(), 1);
    });

    test('with reassign the one record moves to the new patient', async () => {
      await service.link('04A1B2C3', 'U2', 'tester', true);
      const all = await m().PatientCard.find();
      assert.equal(all.length, 1);
      assert.equal(all[0].uhid, 'U2');
    });

    test('the same patient in another format gets the existing record', async () => {
      const card = await service.link('04A1B2C3', 'U1', 'tester');
      assert.equal(card.cardId, '0077705923');
      assert.equal(await m().PatientCard.countDocuments(), 1);
    });
  });

  describe('one active card per patient', () => {
    const OLD = '04A1B2C3';
    const NEW = '04D4E5F6';
    const card = async (cardId: string) => (await m().PatientCard.findOne({ cardId }).lean()) as any;
    const activeOf = async (uhid: string) => ((await m().PatientCard.find({ uhid }).lean()) as any[]).filter((c) => c.status !== 'replaced');

    beforeEach(async () => {
      for (const uhid of ['P1', 'P2']) await m().Patient.create({ uhid, name: `Patient ${uhid}`, phone: '9876543210', gender: 'Female', age: 40 } as any);
    });

    test("linking a new card replaces the patient's older active card", async () => {
      const first = await service.link(OLD, 'P1', 'desk');
      assert.equal(first.status, 'active');
      assert.deepEqual(first.replaced, []);
      const result = await service.link(NEW, 'P1', 'desk');
      assert.equal(result.status, 'active');
      assert.deepEqual(result.replaced, [cardHint(OLD)]);
      assert.equal((await card(NEW)).status, 'active');
      const old = await card(OLD);
      assert.equal(old.status, 'replaced');
      assert.ok(old.replacedAt instanceof Date);
    });

    test('two links for one patient at once leave exactly one active card, the newest', async () => {
      for (let round = 0; round < 10; round++) {
        await m().PatientCard.deleteMany({});
        await service.link('04000001', 'P1', 'desk');
        await Promise.all(['04A1B2C3', '04D4E5F6', '04F0E1D2'].map((id) => service.link(id, 'P1', 'desk')));
        const all = (await m().PatientCard.find({ uhid: 'P1' }).lean()) as any[];
        const active = all.filter((c) => c.status !== 'replaced');
        assert.equal(active.length, 1, `round ${round}: ${JSON.stringify(all.map((c) => [c.cardId, c.status]))}`);
        assert.equal(active[0].linkedAt.getTime(), Math.max(...all.map((c) => c.linkedAt.getTime())), `round ${round}`);
      }
    });

    test('the slower of two racing links steps back when a newer card is already active', async () => {
      // The other desk's link landed with a later linkedAt while this one was running.
      await m().PatientCard.create({ cardId: NEW, uhid: 'P1', linkedBy: 'other desk', status: 'active', linkedAt: new Date(Date.now() + 60_000) } as any);
      const result = await service.link(OLD, 'P1', 'desk');
      assert.equal(result.status, 'replaced');
      assert.deepEqual(result.replaced, []);
      assert.deepEqual((await activeOf('P1')).map((c) => c.cardId), [NEW]);
    });

    test("re-linking the patient's own replaced card makes it active again and replaces the newer one", async () => {
      await service.link(OLD, 'P1', 'desk');
      await service.link(NEW, 'P1', 'desk');
      const result = await service.link(OLD, 'P1', 'desk');
      assert.equal(result.status, 'active');
      assert.deepEqual(result.replaced, [cardHint(NEW)]);
      const old = await card(OLD);
      assert.equal(old.status, 'active');
      assert.equal(old.replacedAt, undefined);
      assert.equal((await card(NEW)).status, 'replaced');
      assert.equal((await activeOf('P1')).length, 1);
      assert.equal(await m().PatientCard.countDocuments(), 2);
    });

    test('linking the same card again for the same patient is idempotent', async () => {
      await service.link(OLD, 'P1', 'desk');
      const first = await service.link(NEW, 'P1', 'desk', false, true);
      const again = await service.link(NEW, 'P1', 'desk', false, true);
      assert.equal(again.status, 'active');
      assert.equal(String(again._id), String(first._id));
      assert.deepEqual(again.replaced, []);
      assert.equal((await card(OLD)).status, 'replaced');
      assert.equal(await m().PatientCard.countDocuments({ cardId: NEW }), 1);
    });

    test('a replaced card is refused on tap and findUhid with the replaced message', async () => {
      await service.link(OLD, 'P1', 'desk');
      await service.link(NEW, 'P1', 'desk');
      await assert.rejects(service.tap(OLD, 'desk', 'front-desk'), replacedError);
      await assert.rejects(service.findUhid(OLD), replacedError);
      await assert.rejects(service.findByCard(OLD), replacedError);
      assert.equal((await card(OLD)).lastUsedAt, undefined);
      assert.equal(await service.findUhid(NEW), 'P1');
    });

    test('a replaced card read in another reader format is still refused as replaced', async () => {
      await service.link(OLD, 'P1', 'desk');
      await service.link(NEW, 'P1', 'desk');
      const decimal = BigInt(`0x${OLD}`).toString().padStart(10, '0');
      assert.equal(decimal, '0077705923');
      await assert.rejects(service.findUhid(decimal), replacedError);
      await assert.rejects(service.findUhid('3283263748'), replacedError);
      await assert.rejects(service.findByCard(decimal), replacedError);
    });

    test('a replaced card of another patient can be linked without reassign', async () => {
      await service.link(OLD, 'P1', 'desk');
      await service.link(NEW, 'P1', 'desk');
      const result = await service.link(OLD, 'P2', 'desk');
      assert.equal(result.uhid, 'P2');
      assert.equal(result.status, 'active');
      assert.deepEqual(result.replaced, []);
      assert.equal(await m().PatientCard.countDocuments({ cardId: OLD }), 1);
      assert.equal((await card(OLD)).replacedAt, undefined);
      assert.deepEqual((await activeOf('P1')).map((c) => c.cardId), [NEW]);
      assert.equal(await service.findUhid(OLD), 'P2');
    });

    test('an active card of another patient still needs reassign', async () => {
      await service.link(OLD, 'P1', 'desk');
      await assert.rejects(service.link(OLD, 'P2', 'desk'), ConflictException);
      assert.equal((await card(OLD)).uhid, 'P1');
      const moved = await service.link(OLD, 'P2', 'desk', true);
      assert.equal(moved.uhid, 'P2');
      assert.equal(moved.status, 'active');
      assert.equal((await activeOf('P1')).length, 0);
    });

    test('written link stamps writtenAt', async () => {
      const plain = await service.link(OLD, 'P1', 'desk');
      assert.equal(plain.writtenAt, undefined);
      const written = await service.link(NEW, 'P1', 'desk', false, true);
      assert.ok(written.writtenAt instanceof Date);
      assert.ok((await card(NEW)).writtenAt instanceof Date);
      assert.equal((await card(OLD)).writtenAt, undefined);
    });

    test("a written card moved to another patient loses its written mark: the text names the old patient", async () => {
      await service.link(OLD, 'P1', 'desk', false, true);
      await service.link(NEW, 'P1', 'desk', false, true);
      assert.equal((await service.link(NEW, 'P1', 'desk')).writtenAt instanceof Date, true, 'relinked to its own patient: still written');
      const moved = await service.link(OLD, 'P2', 'desk');
      assert.equal(moved.writtenAt, undefined);
      const rewritten = await service.link(NEW, 'P2', 'desk', true, true);
      assert.ok(rewritten.writtenAt instanceof Date);
    });

    test('list puts the active card first', async () => {
      for (const id of ['04000001', '04000002', '04000003']) await service.link(id, 'P1', 'desk');
      await service.link('04000001', 'P1', 'desk');
      const list = await service.list('P1');
      assert.deepEqual(list.map((c) => [c.cardId, c.status]), [['04000001', 'active'], ['04000003', 'replaced'], ['04000002', 'replaced']]);
    });

    test('cards linked before card status existed count as active and are replaced by a new link', async () => {
      await m().PatientCard.collection.insertOne({ cardId: OLD, uhid: 'P1', linkedBy: 'Seed', createdAt: new Date(Date.now() - 60_000) });
      assert.equal(await service.findUhid(OLD), 'P1');
      const result = await service.link(NEW, 'P1', 'desk');
      assert.deepEqual(result.replaced, [cardHint(OLD)]);
      assert.equal((await card(OLD)).status, 'replaced');
    });
  });
});
