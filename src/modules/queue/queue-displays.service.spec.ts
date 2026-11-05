import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { QueueDisplaysService } from './queue-displays.service';

const refusal = async (promise: Promise<unknown>) => {
  let caught: unknown;
  await assert.rejects(promise, (e) => {
    caught = e;
    return true;
  });
  const error = caught as { getStatus(): number; getResponse(): string | Record<string, unknown> };
  const body = error.getResponse();
  return { status: error.getStatus(), message: typeof body === 'string' ? body : body.message, code: typeof body === 'string' ? undefined : body.code };
};

describe('QueueDisplaysService.authenticate', () => {
  const m = models();
  let service: QueueDisplaysService;

  before(connectTestDb);
  after(closeTestDb);
  beforeEach(async () => {
    await resetTestDb();
    service = new QueueDisplaysService(m.QueueDisplay);
  });

  test('a kiosk key that is missing, malformed or removed is refused with KIOSK_REVOKED, in the same words as before', async () => {
    const { display, key } = await service.create('Front kiosk', 'kiosk', 'Admin');
    assert.equal(String((await service.authenticate(`Kiosk ${key}`, 'kiosk'))._id), String(display._id));

    for (const header of [undefined, 'Kiosk not-a-key']) {
      assert.deepEqual(await refusal(service.authenticate(header, 'kiosk')), { status: 401, message: 'A kiosk key is required', code: 'KIOSK_REVOKED' });
    }
    await service.remove(String(display._id));
    const removed = await refusal(service.authenticate(`Kiosk ${key}`, 'kiosk'));
    assert.deepEqual(removed, { status: 401, message: 'This kiosk link is no longer valid. Ask an administrator for a new one.', code: 'KIOSK_REVOKED' });
    // Tablets in the field still match these words.
    assert.match(removed.message as string, /kiosk (key|link)/);
  });

  test('a display key refusal is unchanged: no code, the same words', async () => {
    const { display, key } = await service.create('Waiting room', 'display', 'Admin');
    assert.deepEqual(await refusal(service.authenticate(undefined)), { status: 401, message: 'A display key is required', code: undefined });
    await service.remove(String(display._id));
    assert.deepEqual(await refusal(service.authenticate(`Display ${key}`)), {
      status: 401,
      message: 'This display link is no longer valid. Ask an administrator for a new one.',
      code: undefined,
    });
  });
});
