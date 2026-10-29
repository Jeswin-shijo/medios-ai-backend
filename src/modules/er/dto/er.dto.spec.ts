import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ArrivalDto, ExpectedDto, BayAssignDto, BayDto, BayQueryDto, DispositionDto, RetriageDto, TriageDto, TriageSuggestDto } from './er.dto';

const check = async (cls: new () => object, body: object) => validate(plainToInstance(cls, body));
const ok = async (cls: new () => object, body: object) => assert.deepEqual(await check(cls, body), []);
const bad = async (cls: new () => object, body: object) => assert.ok((await check(cls, body)).length > 0);

const arrival = { mode: 'walk-in', complaint: 'chest-pain' };
const emergency = { gender: 'Male', approxAge: 40, description: 'Grey shirt, no ID' };

describe('ArrivalDto', () => {
  test('accepts one identifier, or an emergency with its fields', async () => {
    await ok(ArrivalDto, { ...arrival, uhid: 'MHK202600003' });
    await ok(ArrivalDto, { ...arrival, patientId: '507f1f77bcf86cd799439011' });
    await ok(ArrivalDto, { ...arrival, cardId: '04A1B2C3' });
    await ok(ArrivalDto, { ...arrival, emergency });
  });
  test('rejects a bad complaint or mode', async () => {
    await bad(ArrivalDto, { ...arrival, complaint: 'toothache', uhid: 'X' });
    await bad(ArrivalDto, { ...arrival, mode: 'helicopter', uhid: 'X' });
  });
  test('rejects two identifiers at once, and none', async () => {
    await bad(ArrivalDto, { ...arrival, uhid: 'MHK1', cardId: '04A1' });
    await bad(ArrivalDto, { ...arrival, uhid: 'MHK1', emergency });
    await bad(ArrivalDto, arrival);
  });
  test('an emergency needs gender, age and description', async () => {
    await bad(ArrivalDto, { ...arrival, emergency: { approxAge: 40, description: 'x' } });
    await bad(ArrivalDto, { ...arrival, emergency: { gender: 'Male', description: 'x' } });
    await bad(ArrivalDto, { ...arrival, emergency: { gender: 'Male', approxAge: 40 } });
    await bad(ArrivalDto, { ...arrival, emergency: { ...emergency, approxAge: 121 } });
    await bad(ArrivalDto, { ...arrival, emergency: { ...emergency, gender: 'Robot' } });
  });
});

describe('ExpectedDto', () => {
  const body = { complaint: 'Road accident', ageSex: '30 M', mode: 'ambulance', etaMinutes: 15 };
  test('accepts a valid card and bounds the ETA to 1-240 minutes', async () => {
    await ok(ExpectedDto, body);
    await bad(ExpectedDto, { ...body, etaMinutes: 0 });
    await bad(ExpectedDto, { ...body, etaMinutes: 241 });
    await bad(ExpectedDto, { ...body, ageSex: '' });
    await bad(ExpectedDto, { ...body, complaint: 'x'.repeat(201) });
  });
});

describe('TriageDto', () => {
  const body = { complaint: 'chest-pain', colour: 'orange', vitals: { spo2: 95, bpSystolic: 130, bpDiastolic: 80, heartRate: 90 }, painScore: 5 };
  test('accepts a valid triage', async () => ok(TriageDto, body));
  test('rejects a bad colour', async () => bad(TriageDto, { ...body, colour: 'purple' }));
  test('rejects a bad complaint', async () => bad(TriageDto, { ...body, complaint: 'nope' }));
  test('rejects pain 11', async () => bad(TriageDto, { ...body, painScore: 11 }));
  test('rejects SpO2 120', async () => bad(TriageDto, { ...body, vitals: { spo2: 120 } }));
  test('rejects a heart rate of 10 and a temperature of 50', async () => {
    await bad(TriageDto, { ...body, vitals: { heartRate: 10 } });
    await bad(TriageDto, { ...body, vitals: { temperature: 50 } });
  });
  test('limits the lower-colour reason to 300 characters', async () => {
    await ok(TriageDto, { ...body, reason: 'x'.repeat(300) });
    await bad(TriageDto, { ...body, reason: 'x'.repeat(301) });
  });
});

describe('TriageSuggestDto', () => {
  test('takes no reasons, only complaint and readings', async () => {
    await ok(TriageSuggestDto, { complaint: 'fever', vitals: { temperature: 39 } });
    await bad(TriageSuggestDto, { complaint: 'fever', vitals: { respiratoryRate: 3 } });
  });
});

describe('RetriageDto', () => {
  test('needs a colour and a reason', async () => {
    await ok(RetriageDto, { colour: 'red', reason: 'Getting worse' });
    await bad(RetriageDto, { colour: 'red' });
    await bad(RetriageDto, { colour: 'red', reason: '' });
    await bad(RetriageDto, { colour: 'red', reason: 'x'.repeat(301) });
  });
});

describe('DispositionDto', () => {
  test('takes one of the five kinds and notes up to 1000', async () => {
    await ok(DispositionDto, { kind: 'admit', notes: 'x'.repeat(1000) });
    await bad(DispositionDto, { kind: 'vanished' });
    await bad(DispositionDto, { kind: 'home', notes: 'x'.repeat(1001) });
  });
});

describe('bays', () => {
  test('each bay in PUT bays has a name, a kind and outOfUse', async () => {
    await ok(BayDto, { name: 'Bay 1', kind: 'resus', outOfUse: false });
    await bad(BayDto, { name: 'Bay 1', kind: 'tent', outOfUse: false });
    await bad(BayDto, { name: '', kind: 'bay', outOfUse: false });
    await bad(BayDto, { name: 'Bay 1', kind: 'bay' });
  });
  test('assigning takes a bay id or null, never nothing', async () => {
    await ok(BayAssignDto, { bayId: '507f1f77bcf86cd799439011' });
    await ok(BayAssignDto, { bayId: null });
    await bad(BayAssignDto, {});
    await bad(BayAssignDto, { bayId: 'abc' });
  });
  test('the suggestion query needs a real colour', async () => {
    await ok(BayQueryDto, { colour: 'red' });
    await bad(BayQueryDto, { colour: 'pink' });
    await bad(BayQueryDto, {});
  });
});
