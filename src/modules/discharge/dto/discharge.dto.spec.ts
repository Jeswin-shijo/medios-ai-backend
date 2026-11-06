import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DischargeCheckDto, DischargeReasonDto, EditDischargeOrderDto, OrderDischargeDto } from './discharge.dto';

const errors = async (cls: new () => object, body: object) => validate(plainToInstance(cls, body));
const ok = async (cls: new () => object, body: object) => assert.deepEqual(await errors(cls, body), [], JSON.stringify(body));
const bad = async (cls: new () => object, body: object) => assert.ok((await errors(cls, body)).length > 0, JSON.stringify(body));

const line = { medicine: 'pantoprazole', product: 'pantoprazole-tab-40', dose: 40, route: 'oral', frequency: 'OD', durationDays: 7 };
const DOCTOR_ID = '507f1f77bcf86cd799439011';
const home = { kind: 'home', plannedLeaveAt: '2026-09-26T13:00', diagnosis: 'Pneumonia', condition: 'improved', takeHome: { lines: [line] }, followUp: { inDays: 7, doctorId: DOCTOR_ID } };

describe('OrderDischargeDto', () => {
  test('a Home order with medicines and a follow-up, or with "none" for both, is accepted', async () => {
    await ok(OrderDischargeDto, home);
    await ok(OrderDischargeDto, { ...home, takeHome: 'none', followUp: 'none' });
    await ok(OrderDischargeDto, { kind: 'died', diagnosis: 'Myocardial infarction', timeOfDeath: '2026-09-26T10:40:00+05:30', causeOfDeath: 'Cardiogenic shock' });
  });
  test('a bad kind, condition, time, diagnosis or note is 400', async () => {
    await bad(OrderDischargeDto, { ...home, kind: 'sideways' });
    await bad(OrderDischargeDto, { ...home, condition: 'cured' });
    await bad(OrderDischargeDto, { ...home, plannedLeaveAt: 'tomorrow' });
    await bad(OrderDischargeDto, { ...home, diagnosis: '   ' });
    await bad(OrderDischargeDto, { ...home, diagnosis: 'x'.repeat(301) });
    await bad(OrderDischargeDto, { ...home, note: 'x'.repeat(1001) });
  });
  test('take-home and follow-up are "none" or a valid choice', async () => {
    await bad(OrderDischargeDto, { ...home, takeHome: 'nothing' });
    await bad(OrderDischargeDto, { ...home, takeHome: { lines: [] } });
    await bad(OrderDischargeDto, { ...home, takeHome: { lines: [{ ...line, frequency: 'WEEKLY' }] } });
    await bad(OrderDischargeDto, { ...home, followUp: { inDays: 0 } });
    await bad(OrderDischargeDto, { ...home, followUp: { inDays: 7, doctorId: 'nope' } });
  });
});

describe('the other order DTOs', () => {
  test('an edit sends only what changes', async () => {
    await ok(EditDischargeOrderDto, {});
    await ok(EditDischargeOrderDto, { note: 'Home with family', takeHome: { lines: [line] }, followUp: { inDays: 10 } });
    await bad(EditDischargeOrderDto, { diagnosis: '' });
    await bad(EditDischargeOrderDto, { followUp: { inDays: 400 } });
  });
  test('a cancel reason is 1 to 300 characters; a check names the plan', async () => {
    await bad(DischargeReasonDto, { reason: '  ' });
    await bad(DischargeReasonDto, { reason: 'x'.repeat(301) });
    await ok(DischargeReasonDto, { reason: 'Spiked a fever again' });
    await ok(DischargeCheckDto, { planId: DOCTOR_ID, lines: [line] });
    await bad(DischargeCheckDto, { planId: 'nope', lines: [line] });
  });
});
