import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { SchedulingRoomsService } from './scheduling-rooms.service';
import { SchedulingSettingsService } from './scheduling-settings.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };

describe('SchedulingRoomsService on the clinic clock', () => {
  const m = models();
  let svc: SchedulingRoomsService;
  const saved = process.env.CLINIC_DATE;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    if (saved === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = saved;
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    process.env.CLINIC_DATE = '2026-09-26';
    svc = new SchedulingRoomsService(m.RoomBlock, new SchedulingSettingsService(new SettingsService(m.HospitalSettings)));
  });

  test('rooms() keeps blocks that end after the clinic time, not after the real time', async () => {
    // Real time is long after 26 Sep 2026; the blocks are on the clinic clock.
    const future = await svc.addBlock(ADMIN, 'ot-1', { from: new Date('2026-09-26T14:00'), to: new Date('2026-09-26T16:00'), reason: 'Deep clean' });
    await svc.addBlock(ADMIN, 'ot-1', { from: new Date('2026-09-20T08:00'), to: new Date('2026-09-20T09:00'), reason: 'Past' });
    const rooms = await svc.rooms();
    const ot1 = rooms.find((r) => r.key === 'ot-1')!;
    assert.deepEqual(ot1.blocks.map((b) => b.id), [future.id], 'the block just added stays; the one before the clinic day is gone');
    assert.equal(ot1.blocks[0].reason, 'Deep clean');
  });

  test('a block that has already ended on the clinic clock is not listed', async () => {
    process.env.CLINIC_DATE = '2026-09-27';
    await svc.addBlock(ADMIN, 'ot-1', { from: new Date('2026-09-26T14:00'), to: new Date('2026-09-26T16:00') });
    assert.equal((await svc.rooms()).find((r) => r.key === 'ot-1')!.blocks.length, 0);
  });
});
