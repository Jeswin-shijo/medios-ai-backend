import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AckDto, AmendDto, AreaQueryDto, CollectDto, IdParam, OrderDto, ReasonDto, RejectDto, RequestsQueryDto, ResultsDto, SnapshotQueryDto } from './lab.dto';

const run = (cls: new () => object, body: object) => {
  const inst = plainToInstance(cls, body);
  return validate(inst).then((errors) => ({ errors, inst }));
};
const ok = async (cls: new () => object, body: object) => assert.deepEqual((await run(cls, body)).errors, []);
const bad = async (cls: new () => object, body: object) => assert.ok((await run(cls, body)).errors.length > 0);

const order = { patientId: '507f1f77bcf86cd799439011', tests: ['cbc', 'troponin'], priority: 'stat' };

describe('OrderDto', () => {
  test('accepts a normal order, with an optional note and repeat', async () => {
    await ok(OrderDto, order);
    await ok(OrderDto, { ...order, note: 'fasting', repeatAfterHours: 6 });
  });
  test('rejects an unknown test, 0 or 11 tests, and a duplicate', async () => {
    await bad(OrderDto, { ...order, tests: ['cbc', 'mystery'] });
    await bad(OrderDto, { ...order, tests: [] });
    await bad(OrderDto, { ...order, tests: ['cbc', 'crp', 'rft', 'electrolytes', 'lft', 'glucose', 'hba1c', 'lipid', 'coag', 'troponin', 'ddimer'] });
    await bad(OrderDto, { ...order, tests: ['cbc', 'cbc'] });
  });
  test('ten distinct tests are allowed', async () => {
    await ok(OrderDto, { ...order, tests: ['cbc', 'crp', 'rft', 'electrolytes', 'lft', 'glucose', 'hba1c', 'lipid', 'coag', 'troponin'] });
  });
  test('rejects a bad priority, patient id, long note and repeatAfterHours outside 1 to 72', async () => {
    await bad(OrderDto, { ...order, priority: 'asap' });
    await bad(OrderDto, { ...order, patientId: 'nope' });
    await bad(OrderDto, { ...order, note: 'x'.repeat(501) });
    await bad(OrderDto, { ...order, repeatAfterHours: 0 });
    await bad(OrderDto, { ...order, repeatAfterHours: 73 });
    await bad(OrderDto, { ...order, repeatAfterHours: 1.5 });
    await ok(OrderDto, { ...order, repeatAfterHours: 72 });
  });
});

describe('OrderDto note', () => {
  test('the note is trimmed', async () => {
    const { errors, inst } = await run(OrderDto, { ...order, note: '  fasting  ' });
    assert.deepEqual(errors, []);
    assert.equal((inst as OrderDto).note, 'fasting');
  });
});

describe('ReasonDto and AckDto', () => {
  test('reason is 1 to 300 characters after trimming', async () => {
    await ok(ReasonDto, { reason: 'Patient refused' });
    await bad(ReasonDto, { reason: '   ' });
    await bad(ReasonDto, {});
    await bad(ReasonDto, { reason: 'x'.repeat(301) });
    await ok(ReasonDto, { reason: 'x'.repeat(300) });
  });
  test('a note is optional and at most 500', async () => {
    await ok(AckDto, {});
    await ok(AckDto, { note: 'called the ward' });
    await bad(AckDto, { note: 'x'.repeat(501) });
  });
});

describe('RejectDto', () => {
  test('needs a reason from the list', async () => {
    await ok(RejectDto, { reason: 'clotted' });
    await bad(RejectDto, {});
    await bad(RejectDto, { reason: 'spilled' });
  });
  test('"other" needs a note', async () => {
    await bad(RejectDto, { reason: 'other' });
    await bad(RejectDto, { reason: 'other', note: '   ' });
    await ok(RejectDto, { reason: 'other', note: 'Tube cracked' });
    await bad(RejectDto, { reason: 'clotted', note: 'x'.repeat(501) });
  });
});

describe('ResultsDto and AmendDto', () => {
  test('accepts numbers for numeric parameters and text for text parameters', async () => {
    await ok(ResultsDto, { values: { 'Troponin I': 0.08 } });
    await ok(ResultsDto, { values: { Haemoglobin: 13.2, WBC: 7, Platelets: 250 } });
    await ok(ResultsDto, { values: { Result: 'No growth', Protein: 'Nil' } });
    await ok(AmendDto, { values: { Glucose: 99 }, reason: 'Transcription error' });
  });
  test('text for a numeric parameter is rejected', async () => {
    await bad(ResultsDto, { values: { 'Troponin I': 'high' } });
    await bad(ResultsDto, { values: { Haemoglobin: '13' } });
  });
  test('a number for a text parameter, an unknown parameter, NaN and out-of-range are rejected', async () => {
    await bad(ResultsDto, { values: { Result: 5 } });
    await bad(ResultsDto, { values: { Mystery: 1 } });
    await bad(ResultsDto, { values: { Glucose: Number.NaN } });
    await bad(ResultsDto, { values: { Glucose: 1_000_001 } });
    await bad(ResultsDto, { values: { Glucose: -1_000_001 } });
    await ok(ResultsDto, { values: { Glucose: 1_000_000 } });
  });
  test('text must be one of its options (any case; Negative and Absent mean Nil); values is a plain, non-empty object', async () => {
    await bad(ResultsDto, { values: { Result: '' } });
    await bad(ResultsDto, { values: { Result: 'x'.repeat(200) } });
    await ok(ResultsDto, { values: { Result: 'growth' } });
    await ok(ResultsDto, { values: { Protein: 'Absent', Sugar: '2+' } });
    const { errors } = await run(ResultsDto, { values: { Result: 'No growth after 48 hours' } });
    assert.match(JSON.stringify(errors), /Result must be one of: No growth, Growth/);
    await bad(ResultsDto, { values: {} });
    await bad(ResultsDto, { values: [1] });
    await bad(ResultsDto, { values: 'x' });
    await bad(ResultsDto, {});
  });
  test('a comment is optional, only for a text parameter, and up to 200 characters', async () => {
    await ok(ResultsDto, { values: { Result: 'Growth' }, comments: { Result: 'E. coli' } });
    await ok(AmendDto, { values: { Result: 'Growth' }, comments: { Result: 'x'.repeat(200) }, reason: 'Organism identified' });
    await bad(ResultsDto, { values: { Result: 'Growth' }, comments: { Result: 'x'.repeat(201) } });
    await bad(ResultsDto, { values: { Glucose: 99 }, comments: { Glucose: 'fasting' } });
    await bad(ResultsDto, { values: { Result: 'Growth' }, comments: { Result: 5 } });
    await bad(ResultsDto, { values: { Result: 'Growth' }, comments: ['E. coli'] });
  });
  test('an amendment needs a reason', async () => {
    await bad(AmendDto, { values: { Glucose: 99 } });
    await bad(AmendDto, { values: { Glucose: 99 }, reason: '  ' });
  });
});

describe('CollectDto', () => {
  test('a sample number is trimmed and upper-cased', async () => {
    const { errors, inst } = await run(CollectDto, { sampleNumber: ' s-261030-0007 ' });
    assert.deepEqual(errors, []);
    assert.equal((inst as CollectDto).sampleNumber, 'S-261030-0007');
  });
  test('a malformed sample number is rejected', async () => {
    await bad(CollectDto, { sampleNumber: 'S-26103-0007' });
    await bad(CollectDto, { sampleNumber: 'X-261030-0007' });
    await bad(CollectDto, { sampleNumber: 'S-261030-00071' });
    await bad(CollectDto, { sampleNumber: '' });
    await bad(CollectDto, {});
  });
});

describe('params and queries', () => {
  test('ids must be Mongo ids', async () => {
    await ok(IdParam, { id: '507f1f77bcf86cd799439011' });
    await bad(IdParam, { id: '123' });
  });
  test('range is 24h or 7d', async () => {
    await ok(SnapshotQueryDto, {});
    await ok(SnapshotQueryDto, { range: '7d' });
    await bad(SnapshotQueryDto, { range: '30d' });
  });
  test('area is ER, Ward or OPD', async () => {
    await ok(AreaQueryDto, { area: 'Ward' });
    await bad(AreaQueryDto, { area: 'ICU' });
    await ok(RequestsQueryDto, { status: 'open', search: 'LR-0001', area: 'ER' });
    await bad(RequestsQueryDto, { status: 'weird' });
  });
});
