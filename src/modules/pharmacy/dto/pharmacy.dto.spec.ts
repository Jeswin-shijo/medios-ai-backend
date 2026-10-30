import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AdjustDto,
  AnswerDto,
  ApproveDto,
  CheckDto,
  FlagParam,
  IdParam,
  IssueDto,
  LevelDto,
  MovementsQueryDto,
  PharmacyOrderDto,
  OrdersQueryDto,
  QueryDto,
  PharmacyReasonDto,
  ReceiveDto,
  PharmacySnapshotQueryDto,
  WorklistQueryDto,
} from './pharmacy.dto';

const run = async (cls: new () => object, body: object) => {
  const inst = plainToInstance(cls, body);
  return { errors: await validate(inst), inst };
};
const ok = async (cls: new () => object, body: object) => assert.deepEqual((await run(cls, body)).errors, []);
const bad = async (cls: new () => object, body: object) => assert.ok((await run(cls, body)).errors.length > 0);

const line = { medicine: 'ibuprofen', product: 'ibuprofen-tab-400', dose: 400, route: 'oral', frequency: 'TDS', durationDays: 5 };
const order = { patientId: '507f1f77bcf86cd799439011', priority: 'routine', lines: [line] };

describe('PharmacyOrderDto and CheckDto', () => {
  test('a normal order, a STAT line without days, and a confirm are accepted', async () => {
    await ok(PharmacyOrderDto, order);
    await ok(CheckDto, { patientId: order.patientId, lines: [line] });
    await ok(PharmacyOrderDto, { ...order, lines: [{ ...line, frequency: 'STAT', durationDays: undefined, confirm: { reason: 'tolerated before' } }] });
  });
  test('11 lines, no lines and an unknown frequency are 400', async () => {
    await bad(PharmacyOrderDto, { ...order, lines: Array.from({ length: 11 }, () => line) });
    await bad(PharmacyOrderDto, { ...order, lines: [] });
    await bad(PharmacyOrderDto, { ...order, lines: [{ ...line, frequency: 'WEEKLY' }] });
  });
  test('dose 0, a negative dose and a dose above 100000 are 400', async () => {
    await bad(PharmacyOrderDto, { ...order, lines: [{ ...line, dose: 0 }] });
    await bad(PharmacyOrderDto, { ...order, lines: [{ ...line, dose: -5 }] });
    await bad(PharmacyOrderDto, { ...order, lines: [{ ...line, dose: 100001 }] });
    await ok(PharmacyOrderDto, { ...order, lines: [{ ...line, dose: 0.5 }] });
    await ok(PharmacyOrderDto, { ...order, lines: [{ ...line, dose: 100000 }] });
  });
  test('durationDays 91, 0 and 2.5 are 400; 90 is fine', async () => {
    await bad(PharmacyOrderDto, { ...order, lines: [{ ...line, durationDays: 91 }] });
    await bad(PharmacyOrderDto, { ...order, lines: [{ ...line, durationDays: 0 }] });
    await bad(PharmacyOrderDto, { ...order, lines: [{ ...line, durationDays: 2.5 }] });
    await ok(PharmacyOrderDto, { ...order, lines: [{ ...line, durationDays: 90 }] });
  });
  test('a bad priority, patient id, route, long note and empty confirm reason are 400', async () => {
    await bad(PharmacyOrderDto, { ...order, priority: 'asap' });
    await bad(PharmacyOrderDto, { ...order, patientId: 'nope' });
    await bad(PharmacyOrderDto, { ...order, lines: [{ ...line, route: 'rectal' }] });
    await bad(PharmacyOrderDto, { ...order, note: 'x'.repeat(501) });
    await bad(PharmacyOrderDto, { ...order, lines: [{ ...line, confirm: { reason: '   ' } }] });
  });
});

describe('PharmacyReasonDto', () => {
  test('a missing, blank or 301-character reason is 400', async () => {
    await bad(PharmacyReasonDto, {});
    await bad(PharmacyReasonDto, { reason: '   ' });
    await bad(PharmacyReasonDto, { reason: 'x'.repeat(301) });
    await ok(PharmacyReasonDto, { reason: 'x'.repeat(300) });
  });
});

describe('AnswerDto', () => {
  const ans = { querySeq: 1, outcome: 'keep', reason: 'tolerated' };
  test('querySeq must be an integer: a string, a float and a missing one are 400', async () => {
    await ok(AnswerDto, ans);
    await bad(AnswerDto, { ...ans, querySeq: '1' });
    await bad(AnswerDto, { ...ans, querySeq: 1.5 });
    await bad(AnswerDto, { outcome: 'keep', reason: 'x' });
  });
  test('an outcome `maybe` is 400', async () => {
    await bad(AnswerDto, { ...ans, outcome: 'maybe' });
  });
  test('change and switchTo are checked inside', async () => {
    const change = { product: 'ibuprofen-tab-400', dose: 200, route: 'oral', frequency: 'BD', durationDays: 3 };
    await ok(AnswerDto, { querySeq: 2, outcome: 'change', change });
    await bad(AnswerDto, { querySeq: 2, outcome: 'change', change: { ...change, dose: 0 } });
    await ok(AnswerDto, { querySeq: 2, outcome: 'switch', switchTo: line });
    await bad(AnswerDto, { querySeq: 2, outcome: 'switch', switchTo: { ...line, frequency: 'x' } });
  });
});

describe('ApproveDto and QueryDto', () => {
  test('approve takes an optional reason and flag', async () => {
    await ok(ApproveDto, {});
    await ok(ApproveDto, { reason: 'ok', allergyReviewed: true });
    await bad(ApproveDto, { allergyReviewed: 'yes' });
    await bad(ApproveDto, { reason: 'x'.repeat(301) });
  });
  test('a query needs a kind from the list and a question of 1 to 300 characters', async () => {
    await ok(QueryDto, { kind: 'clash', question: 'Both needed?' });
    await bad(QueryDto, { kind: 'rude', question: 'x' });
    await bad(QueryDto, { kind: 'clash', question: '' });
    await bad(QueryDto, { kind: 'clash', question: 'x'.repeat(301) });
  });
});

describe('IssueDto', () => {
  test('store, batch number and quantity are checked', async () => {
    await ok(IssueDto, {});
    await ok(IssueDto, { store: 'er', batchNo: 'B-2026/01', quantity: 10 });
    await bad(IssueDto, { store: 'attic' });
    await bad(IssueDto, { batchNo: 'bad batch!' });
    await bad(IssueDto, { quantity: 0 });
    await bad(IssueDto, { quantity: 10001 });
  });
});

describe('stock DTOs', () => {
  const rec = { product: 'enoxaparin-syringe-60', store: 'main', batchNo: 'B1', expiry: '2027-10-30', quantity: 20 };
  test('receive: expiry 30/10/2026, a bad batch, quantity 0 and 10001 are 400', async () => {
    await ok(ReceiveDto, rec);
    await bad(ReceiveDto, { ...rec, expiry: '30/10/2026' });
    await ok(ReceiveDto, { ...rec, batchNo: 'B.12 34' });
    await bad(ReceiveDto, { ...rec, batchNo: 'a;b' });
    await bad(ReceiveDto, { ...rec, batchNo: 'x'.repeat(41) });
    await bad(ReceiveDto, { ...rec, quantity: 0 });
    await bad(ReceiveDto, { ...rec, quantity: 10001 });
    await bad(ReceiveDto, { ...rec, store: 'x' });
  });
  test('adjust: change 0, 100001 and 1.5 are 400; a reason from the list', async () => {
    await ok(AdjustDto, { change: -3, reason: 'damaged' });
    await ok(AdjustDto, { change: 100000, reason: 'count-correction' });
    await bad(AdjustDto, { change: 0, reason: 'damaged' });
    await bad(AdjustDto, { change: 100001, reason: 'damaged' });
    await bad(AdjustDto, { change: -100001, reason: 'damaged' });
    await bad(AdjustDto, { change: 1.5, reason: 'damaged' });
    await bad(AdjustDto, { change: 1, reason: 'lost' });
  });
  test('reorder level: 0 to 100000, whole', async () => {
    await ok(LevelDto, { product: 'x', store: 'er', reorderLevel: 0 });
    await bad(LevelDto, { product: 'x', store: 'er', reorderLevel: -1 });
    await bad(LevelDto, { product: 'x', store: 'er', reorderLevel: 100001 });
    await bad(LevelDto, { product: 'x', store: 'er', reorderLevel: 2.5 });
  });
});

describe('queries and params', () => {
  test('worklist view `all` or none is 400', async () => {
    await ok(WorklistQueryDto, { view: 'queries' });
    await bad(WorklistQueryDto, { view: 'all' });
    await bad(WorklistQueryDto, {});
  });
  test('snapshots range, orders status and limit', async () => {
    await ok(PharmacySnapshotQueryDto, { range: '7d' });
    await bad(PharmacySnapshotQueryDto, { range: '30d' });
    await ok(OrdersQueryDto, { status: 'issued', setting: 'ER', limit: '20' });
    await bad(OrdersQueryDto, { status: 'gone' });
    await bad(OrdersQueryDto, { setting: 'Home' });
    await bad(OrdersQueryDto, { limit: '0' });
    await bad(MovementsQueryDto, { store: 'x' });
  });
  test(':id is a Mongo id and :key matches [a-z0-9.-]{1,60}', async () => {
    await ok(IdParam, { id: '507f1f77bcf86cd799439011' });
    await bad(IdParam, { id: 'abc' });
    await ok(FlagParam, { id: '507f1f77bcf86cd799439011', key: 'kidney.0-30' });
    await ok(FlagParam, { id: '507f1f77bcf86cd799439011', key: 'clash.amoxicillin-clavulanate' });
    await bad(FlagParam, { id: '507f1f77bcf86cd799439011', key: 'Bad Key' });
    await bad(FlagParam, { id: '507f1f77bcf86cd799439011', key: 'x'.repeat(61) });
  });
});
