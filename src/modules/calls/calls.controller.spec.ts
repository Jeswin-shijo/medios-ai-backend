import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { UserRole } from '../users/schemas/user.schema';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';

const TOOLS_SECRET = 'tools-secret-0123456789abcdef';
const WEBHOOK_SECRET = 'webhook-secret-0123456789abcdef';

/** The controller with fake services; `provider` is the server's CALL_PROVIDER. */
function controller(provider: string, env: Record<string, unknown> = {}) {
  const seen: { tool?: [string, unknown, unknown]; result?: unknown; findOne?: [string, boolean] } = {};
  const calls = {
    providerInfo: { provider, live: provider === 'snapserve' },
    recordResult: async (result: unknown) => {
      seen.result = result;
      return { matched: true };
    },
    findOne: async (id: string, withRawResult: boolean) => {
      seen.findOne = [id, withRawResult];
      return { id };
    },
  };
  const inbound = {
    run: async (tool: string, args: unknown, ctx: unknown) => {
      seen.tool = [tool, args, ctx];
      return { ok: true, message: 'Verified.' };
    },
  };
  const values: Record<string, unknown> = { 'callAgent.toolsSecret': TOOLS_SECRET, 'callAgent.webhookSecret': WEBHOOK_SECRET, ...env };
  const config = { get: (key: string) => values[key] };
  return { ctrl: new CallsController(calls as any, inbound as any, config as any), seen };
}

/** A minimal Express response that records what was sent. */
function response() {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
      return res;
    },
  };
  return { res: res as any, sent };
}

describe('CallsController: inbound tools route', () => {
  const body = { args: { patient_name: 'Rekha Suresh' }, call: { id: 'call-1', fromNumber: '+919876543210' } };

  test('404 when CALL_TOOLS_SECRET is not set', async () => {
    const { ctrl } = controller('snapserve', { 'callAgent.toolsSecret': '' });
    await assert.rejects(() => ctrl.tool('find_patient', TOOLS_SECRET, {}, body, response().res), NotFoundException);
  });

  test('404 when the call agent is off, even with the secret', async () => {
    const { ctrl } = controller('none');
    await assert.rejects(() => ctrl.tool('find_patient', TOOLS_SECRET, {}, body, response().res), NotFoundException);
  });

  test('401 with a wrong or missing secret', async () => {
    const { ctrl } = controller('snapserve');
    await assert.rejects(() => ctrl.tool('find_patient', 'wrong-secret', {}, body, response().res), UnauthorizedException);
    await assert.rejects(() => ctrl.tool('find_patient', undefined, {}, body, response().res), UnauthorizedException);
  });

  test('wrapped arguments: the call id and caller number come from the envelope around them', async () => {
    const { ctrl, seen } = controller('snapserve');
    const wrapped = { arguments: JSON.stringify({ patient_name: 'Rekha Suresh' }), callId: 'call-7', fromNumber: '+919876543210' };
    await ctrl.tool('find_patient', TOOLS_SECRET, {}, wrapped, response().res);
    assert.deepEqual(seen.tool, ['find_patient', { patient_name: 'Rekha Suresh' }, { providerCallId: 'call-7', callerNumber: '+919876543210' }]);
  });

  test("unwrapped arguments are the model's own: no call id or caller number is read from them", async () => {
    const { ctrl, seen } = controller('snapserve');
    const unwrapped = {
      patient_name: 'Rekha Suresh',
      caller_number: '+919876543210',
      fromNumber: '+919876543210',
      callId: 'call-8',
      call: { id: 'call-8', fromNumber: '+919876543210' },
      metadata: { from: '+919876543210' },
    };
    await ctrl.tool('find_patient', TOOLS_SECRET, {}, unwrapped, response().res);
    const [, args, ctx] = seen.tool!;
    assert.equal((args as any).patient_name, 'Rekha Suresh');
    assert.deepEqual(ctx, { providerCallId: undefined, callerNumber: undefined });
  });

  test("the provider's headers carry the call id and caller number, whatever the body says", async () => {
    const { ctrl, seen } = controller('snapserve');
    const headers = { 'x-snapserve-call-id': 'call-9', 'x-snapserve-from': '+919876543210' };
    await ctrl.tool('find_patient', TOOLS_SECRET, headers, { patient_name: 'Rekha Suresh', caller_number: '+919876543299' }, response().res);
    assert.deepEqual(seen.tool![2], { providerCallId: 'call-9', callerNumber: '+919876543210' });
  });

  test('the right secret runs the tool and answers plain JSON (snapserve, or simulated in development)', async () => {
    for (const provider of ['snapserve', 'simulated']) {
      const { ctrl, seen } = controller(provider);
      const { res, sent } = response();
      await ctrl.tool('find_patient', TOOLS_SECRET, {}, body, res);
      assert.equal(sent.status, 200);
      assert.deepEqual(sent.body, { ok: true, message: 'Verified.' });
      assert.deepEqual(seen.tool, ['find_patient', { patient_name: 'Rekha Suresh' }, { providerCallId: 'call-1', callerNumber: '+919876543210' }]);
    }
  });
});

describe('CallsController: post-call webhook', () => {
  const payload = { id: 'call-1', dispositionResult: { outcome: 'Confirmed' } };
  const req = { rawBody: Buffer.from(JSON.stringify(payload)) } as any;

  test('the secret may come in the X-MediOS-Webhook-Token header, with ?token= as the fallback', async () => {
    const { ctrl, seen } = controller('snapserve');
    await ctrl.webhook('snapserve', undefined as any, payload, req, undefined, undefined, WEBHOOK_SECRET);
    assert.equal((seen.result as any).outcome, 'confirmed');

    seen.result = undefined;
    await ctrl.webhook('snapserve', WEBHOOK_SECRET, payload, req, undefined, undefined, undefined);
    assert.equal((seen.result as any).outcome, 'confirmed');
  });

  test('a wrong header secret is refused, whatever the URL says', async () => {
    const { ctrl, seen } = controller('snapserve');
    await assert.rejects(() => ctrl.webhook('snapserve', WEBHOOK_SECRET, payload, req, undefined, undefined, 'wrong'), UnauthorizedException);
    await assert.rejects(() => ctrl.webhook('snapserve', 'wrong', payload, req, undefined, undefined, undefined), UnauthorizedException);
    assert.equal(seen.result, undefined);
  });
});

describe('CallsController: one call', () => {
  test("only an admin gets the provider's raw payload", async () => {
    const { ctrl, seen } = controller('snapserve');
    await ctrl.findOne('call-1', UserRole.ADMIN);
    assert.deepEqual(seen.findOne, ['call-1', true]);
    for (const role of [UserRole.DOCTOR, UserRole.NURSE, UserRole.STAFF, UserRole.PHARMACIST, UserRole.LAB]) {
      await ctrl.findOne('call-1', role);
      assert.deepEqual(seen.findOne, ['call-1', false], role);
    }
  });

  test('the call log, transcripts and placing or withdrawing calls are for admin, doctor, nurse and front desk only', () => {
    const staff = [UserRole.ADMIN, UserRole.DOCTOR, UserRole.NURSE, UserRole.STAFF];
    for (const route of ['list', 'findOne', 'confirm', 'book', 'cancel'] as const) {
      assert.deepEqual(Reflect.getMetadata(ROLES_KEY, CallsController.prototype[route]), staff, route);
    }
  });
});
