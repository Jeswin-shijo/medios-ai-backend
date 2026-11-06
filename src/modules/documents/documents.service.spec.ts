import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { DocumentsService } from './documents.service';

describe('DocumentsService', () => {
  const m = models();
  let documents: DocumentsService;
  const make = (status: string) =>
    m.ClinicalDocument.create({ uhid: 'MHK202600901', title: 'Discharge summary', category: 'Discharge Summary', status, signedBy: 'Dr. Shajin', signedOn: '26 Sep 2026, 11:00 AM' });

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    documents = new DocumentsService(m.ClinicalDocument);
  });

  test('a draft is signed by the doctor', async () => {
    const d = await make('Pending Signature');
    const signed = await documents.signDocument(String(d._id), 'Dr. Meena');
    assert.deepEqual([signed.status, signed.signedBy], ['Signed', 'Dr. Meena']);
    assert.ok(signed.signedOn, 'stamped');
    await assert.rejects(documents.signDocument(String(new Types.ObjectId()), 'Dr. Meena'), NotFoundException);
  });

  test('M11: an archived document cannot be signed back to Signed', async () => {
    const d = await make('Archived');
    await assert.rejects(documents.signDocument(String(d._id), 'Dr. Meena'), (e: unknown) => e instanceof ConflictException && /archived/.test((e as Error).message));
    const row = await m.ClinicalDocument.findById(d._id).lean<any>();
    assert.deepEqual([row.status, row.signedBy, row.signedOn], ['Archived', 'Dr. Shajin', '26 Sep 2026, 11:00 AM'], 'unchanged');
  });

  test('archive marks a document Archived once, and never deletes it', async () => {
    const d = await make('Signed');
    assert.equal(await documents.archive(String(d._id)), true);
    assert.equal(await documents.archive(String(d._id)), false, 'already archived');
    assert.equal(await documents.archive('not-an-id'), false);
    assert.equal((await m.ClinicalDocument.findById(d._id).lean<any>()).status, 'Archived');
    assert.equal(await m.ClinicalDocument.countDocuments(), 1);
  });
});
