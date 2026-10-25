import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BlockBedDto, SuggestBedsDto } from './beds.dto';

const valid = {
  patientId: 'MHK202500324',
  roomClass: 'general',
  needs: ['oxygen'],
  department: 'General Medicine',
  doctor: 'Dr. Shajin',
  expectedStayDays: 3,
  notes: '',
};

const check = (body: object) => validate(plainToInstance(SuggestBedsDto, body));

describe('SuggestBedsDto', () => {
  test('accepts a valid request, with empty notes', async () => {
    assert.deepEqual(await check(valid), []);
  });

  test('rejects notes over 4,000 characters with a plain message', async () => {
    const errors = await check({ ...valid, notes: 'x'.repeat(4001) });
    assert.equal(errors.length, 1);
    assert.ok(Object.values(errors[0].constraints ?? {}).includes("Doctor's notes can be at most 4,000 characters."));
  });

  test('rejects a stay of 0 days', async () => {
    assert.equal((await check({ ...valid, expectedStayDays: 0 })).length, 1);
  });

  test('rejects an unknown need', async () => {
    assert.equal((await check({ ...valid, needs: ['wings'] })).length, 1);
  });
});

describe('BlockBedDto', () => {
  test('needs a reason of at most 200 characters', async () => {
    assert.equal((await validate(plainToInstance(BlockBedDto, {}))).length, 1);
    assert.equal((await validate(plainToInstance(BlockBedDto, { reason: 'x'.repeat(201) }))).length, 1);
    assert.deepEqual(await validate(plainToInstance(BlockBedDto, { reason: 'Leaking tap' })), []);
  });
});
