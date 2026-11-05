import * as assert from 'node:assert/strict';
import { describe, test, before, beforeEach, after } from 'node:test';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { PatientCardsService, cardIdCandidates } from './patient-cards.service';

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
});
