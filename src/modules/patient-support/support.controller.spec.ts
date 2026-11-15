import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ExecutionContext, ForbiddenException, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '../users/schemas/user.schema';
import { SupportController } from './support.controller';

const { ADMIN: A, DOCTOR: D, NURSE: N, STAFF: S, PHARMACIST, LAB } = UserRole;
const READ = [A, D, N, S];
const SEND = [A, S];
const REVIEW = [A, D];
const ADMIN = [A];

/** Every `/api/support` route and who may call it (global constraints, "Roles"). */
const TABLE: Record<string, UserRole[]> = {
  'GET overview': READ,
  'POST day-summary': READ,
  'GET tickets': READ,
  'GET tickets/:id': READ,
  'POST tickets': READ,
  'POST tickets/:id/notes': READ,
  'POST tickets/:id/state': READ,
  'POST tickets/:id/hand-on': READ,
  'POST tickets/:id/resolve': READ,
  'GET updates': READ,
  'POST updates/:id/send': SEND,
  'POST updates/:id/dismiss': SEND,
  'GET checkups': READ,
  'GET checkups/:id': READ,
  'POST checkups/:id/answers': READ,
  'POST checkups/:id/no-answer': READ,
  'POST checkups/:id/review': REVIEW,
  'GET feedback': READ,
  'POST feedback': READ,
  'GET templates': READ,
  'GET faqs': READ,
  'GET faqs/search': READ,
  'PUT templates/:key': ADMIN,
  'PUT faqs/:topic': ADMIN,
  'POST faqs': ADMIN,
  'GET patients/:patientId/contact': READ,
  'PUT patients/:patientId/contact': READ,
  'GET settings': READ,
  'PUT settings': ADMIN
};

const proto = SupportController.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;

function routes() {
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && Reflect.getMetadata(PATH_METADATA, proto[name]) !== undefined)
    .map((name) => {
      const handler = proto[name];
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
      return {
        name,
        handler,
        key: `${method} ${Reflect.getMetadata(PATH_METADATA, handler)}`,
        roles: Reflect.getMetadata(ROLES_KEY, handler) as UserRole[] | undefined
      };
    });
}

const guard = new RolesGuard(new Reflector());
function allowed(handler: unknown, role: UserRole): boolean {
  const ctx = {
    getHandler: () => handler,
    getClass: () => SupportController,
    switchToHttp: () => ({ getRequest: () => ({ user: { _id: 'u1', name: 'Someone', role } }) })
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(ctx);
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
}

/** main.ts's global pipe. */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false });
function argType(name: string, kind: RouteParamtypes): unknown {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, SupportController, name) ?? {}) as Record<string, { index: number }>;
  const entry = Object.entries(args).find(([k]) => k.startsWith(`${kind}:`));
  assert.ok(entry, `${name} has that argument`);
  return (Reflect.getMetadata('design:paramtypes', SupportController.prototype, name) as unknown[])[entry![1].index];
}
const body = (name: string, value: unknown) => pipe.transform(value, { type: 'body', metatype: argType(name, RouteParamtypes.BODY) as never, data: '' });
const query = (name: string, value: unknown) => pipe.transform(value, { type: 'query', metatype: argType(name, RouteParamtypes.QUERY) as never, data: '' });

/** Drops the keys a DTO leaves undefined. */
const clean = (v: unknown) => JSON.parse(JSON.stringify(v));
const ID = '507f1f77bcf86cd799439011';
const USER = { _id: 'u1', name: 'Anita Desk', role: S };
const ACTOR = { id: 'u1', name: 'Anita Desk', role: S };

/** The controller over stub services that record each call. */
function wired() {
  const calls: [string, unknown[]][] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, args]);
      return Promise.resolve({ from: name });
    };
  const overview = { overview: rec('overview'), daySummary: rec('daySummary') };
  const tickets = {
    list: rec('list'),
    detail: rec('detail'),
    open: rec('open'),
    note: rec('note'),
    setState: rec('setState'),
    handOn: rec('handOn'),
    resolve: rec('resolve')
  };
  const updates = { list: rec('updates.list'), sendNow: rec('sendNow'), dismiss: rec('dismiss') };
  const checkups = { list: rec('checkups.list'), detail: rec('checkups.detail'), submit: rec('submit'), noAnswer: rec('noAnswer'), review: rec('review') };
  const feedback = { list: rec('feedback.list'), record: rec('record') };
  const texts = {
    templates: rec('templates'),
    faqs: rec('faqs'),
    searchFaqs: rec('searchFaqs'),
    saveTemplate: rec('saveTemplate'),
    saveFaq: rec('saveFaq'),
    addFaq: rec('addFaq')
  };
  const facts = { contactOf: rec('contactOf'), saveContact: rec('saveContact') };
  const settings = { get: rec('settings.get'), save: rec('settings.save') };
  const controller = new SupportController(
    overview as never,
    tickets as never,
    updates as never,
    checkups as never,
    feedback as never,
    texts as never,
    facts as never,
    settings as never
  );
  return { controller, calls };
}

describe('SupportController', () => {
  test('every route is under /support with the roles of the table', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, SupportController), 'support');
    assert.equal(Reflect.getMetadata(ROLES_KEY, SupportController), undefined, 'no class-wide roles to override a route');
    const found = Object.fromEntries(routes().map((r) => [r.key, r.roles]));
    assert.deepEqual(Object.keys(found).sort(), Object.keys(TABLE).sort());
    for (const [key, roles] of Object.entries(TABLE)) assert.deepEqual([...(found[key] ?? [])].sort(), [...roles].sort(), key);
  });

  test('pharmacist and lab get 403 on every route', () => {
    const all = routes();
    assert.equal(all.length, 29);
    for (const r of all) {
      assert.ok(r.roles?.length, `${r.key} names its roles (a route without @Roles lets everyone in)`);
      assert.equal(allowed(r.handler, PHARMACIST), false, `${r.key}: pharmacist`);
      assert.equal(allowed(r.handler, LAB), false, `${r.key}: lab`);
      assert.equal(allowed(r.handler, A), true, `${r.key}: admin`);
    }
  });

  test('a nurse cannot send a held update or review a check-up', () => {
    assert.equal(allowed(proto.sendUpdate, N), false);
    assert.equal(allowed(proto.dismissUpdate, N), false);
    assert.equal(allowed(proto.reviewCheckup, N), false);
    assert.equal(allowed(proto.reviewCheckup, S), false);
    assert.equal(allowed(proto.reviewCheckup, D), true);
    assert.equal(allowed(proto.sendUpdate, S), true);
    assert.equal(allowed(proto.sendUpdate, D), false);
    // A nurse still works tickets and records check-up answers.
    assert.equal(allowed(proto.openTicket, N), true);
    assert.equal(allowed(proto.submitCheckup, N), true);
  });

  test('only an admin edits texts and settings', () => {
    for (const name of ['saveTemplate', 'saveFaq', 'addFaq', 'saveSettings']) {
      for (const role of [D, N, S]) assert.equal(allowed(proto[name], role), false, `${name}: ${role}`);
      assert.equal(allowed(proto[name], A), true, name);
    }
    for (const role of [D, N, S]) assert.equal(allowed(proto.getSettings, role), true, `${role} reads the settings`);
  });

  test('a desk ticket and a desk rating always carry the source desk, whatever the body says', async () => {
    const { controller, calls } = wired();
    const t = (await body('openTicket', {
      callerName: ' Suresh ',
      ticketType: 'billing',
      question: 'Why?',
      source: 'emergency-call',
      providerCallId: 'x'
    })) as never;
    await controller.openTicket(USER, t);
    const [, [actor, input]] = calls[0];
    assert.deepEqual(actor, ACTOR);
    assert.deepEqual(clean(input), { callerName: 'Suresh', ticketType: 'billing', question: 'Why?', source: 'desk' });
    const f = (await body('recordFeedback', { overall: 4, source: 'call' })) as never;
    await controller.recordFeedback(USER, f);
    assert.deepEqual(clean(calls[1][1][1]), { overall: 4, source: 'desk' });
  });

  test('the overview is built for the signed-in viewer; check-ups default to the To do tab', async () => {
    const { controller, calls } = wired();
    await controller.getOverview(USER);
    assert.deepEqual(calls[0], ['overview', [ACTOR]]);
    await controller.listCheckups({});
    assert.deepEqual(calls[1], ['checkups.list', ['to-do']]);
    await controller.listCheckups({ tab: 'done' });
    assert.deepEqual(calls[2], ['checkups.list', ['done']]);
  });

  test('ticket input limits: name 1-80, phone 20, question 1000, resolution needed when answered on the spot', async () => {
    const ok = { callerName: 'A', ticketType: 'other', question: 'Q' };
    await body('openTicket', ok);
    for (const bad of [
      { ...ok, callerName: '' },
      { ...ok, callerName: 'x'.repeat(81) },
      { ...ok, callerPhone: '1'.repeat(21) },
      { ...ok, question: 'x'.repeat(1001) },
      { ...ok, ticketType: 'nope' },
      { ...ok, patientId: 'not-an-id' },
      { ...ok, onTheSpot: true },
      { ...ok, channel: 'email' }
    ]) {
      await assert.rejects(body('openTicket', bad), `rejects ${JSON.stringify(bad).slice(0, 60)}`);
    }
    await body('openTicket', { ...ok, onTheSpot: true, resolution: 'Told him.' });
    await assert.rejects(body('addNote', { body: 'x'.repeat(1001) }));
    await assert.rejects(body('handOn', { ticketType: 'billing', note: 'x'.repeat(501) }));
    await assert.rejects(body('setTicketState', { state: 'closed' }));
    await assert.rejects(body('resolveTicket', { resolution: '' }));
  });

  test('ticket list filters are checked against the catalogue and never pass an array or object into a Mongo filter', async () => {
    const q = (await query('listTickets', { state: 'open', ticketType: 'billing', owner: 'desk', q: ' fees ', limit: '50', today: 'true' })) as Record<
      string,
      unknown
    >;
    assert.deepEqual(clean(q), { state: 'open', ticketType: 'billing', owner: 'desk', q: 'fees', limit: 50, today: true });
    for (const bad of [
      { state: 'nope' },
      { state: ['open'] },
      { owner: { $ne: 'x' } },
      { ticketType: ['a', 'b'] },
      { q: 'x'.repeat(81) },
      { limit: '0' },
      { limit: '201' },
      { today: 'maybe' }
    ]) {
      await assert.rejects(query('listTickets', bad), `rejects ${JSON.stringify(bad)}`);
    }
  });

  test('update list filters are checked against the catalogue', async () => {
    await query('listUpdates', { status: 'held', reason: 'no-consent', trigger: 'admitted', patientId: ID, limit: '20' });
    await query('listUpdates', { reason: 'missing-detail' });
    for (const bad of [{ status: 'x' }, { status: ['held'] }, { reason: { $gt: '' } }, { trigger: 'x' }, { patientId: 'x' }, { limit: '1000' }]) {
      await assert.rejects(query('listUpdates', bad), `rejects ${JSON.stringify(bad)}`);
    }
  });

  test('feedback: overall 1-5, aspects only the four keys each 1-5, comment 500', async () => {
    await body('recordFeedback', { overall: 5, aspects: { communication: 5, staff: 4, waiting: 1, facilities: 3 }, comment: 'Good', complaint: false });
    for (const bad of [
      { overall: 0 },
      { overall: 6 },
      { overall: 3.5 },
      { overall: 3, aspects: { food: 4 } },
      { overall: 3, aspects: { staff: 6 } },
      { overall: 3, aspects: { staff: 2.5 } },
      { overall: 3, aspects: [1, 2] },
      { overall: 3, aspects: 'x' },
      { overall: 3, comment: 'x'.repeat(501) }
    ]) {
      await assert.rejects(body('recordFeedback', bad), `rejects ${JSON.stringify(bad)}`);
    }
  });

  test('contact route: both consent booleans together, contacts limits, one updatesTo form, language and via', async () => {
    const contact = { name: 'Ravi', relation: 'Son', phone: '9876543210' };
    await body('saveContact', { consent: { messages: true, calls: false }, contacts: [contact], updatesToIndex: 0, preferredLanguage: 'ta', via: 'ward' });
    await body('saveContact', { updatesTo: 'self' });
    for (const bad of [
      { consent: { messages: true } },
      { consent: { messages: 'yes', calls: true } },
      { contacts: Array.from({ length: 6 }, () => contact) },
      { contacts: [{ ...contact, name: '' }] },
      { contacts: [{ ...contact, name: 'x'.repeat(81) }] },
      { contacts: [{ ...contact, relation: 'x'.repeat(41) }] },
      { contacts: [{ ...contact, phone: '1'.repeat(21) }] },
      { contacts: [{ name: 'x', relation: 'y' }] },
      { preferredLanguage: 'fr' },
      { via: 'phone' },
      { updatesToIndex: 9 }
    ]) {
      await assert.rejects(body('saveContact', bad), `rejects ${JSON.stringify(bad).slice(0, 70)}`);
    }
  });

  test('texts: template and FAQ limits, topic format', async () => {
    await body('saveTemplate', { en: 'Hello', ta: 'வணக்கம்', approved: true, taChecked: true });
    await assert.rejects(body('saveTemplate', { en: 'x'.repeat(1001) }));
    await assert.rejects(body('saveTemplate', { approved: 'yes' }));
    await body('saveFaq', { title: 'Lifts', keywords: ['lift'], en: 'Lifts are at the main hall.' });
    await assert.rejects(body('saveFaq', { keywords: Array.from({ length: 21 }, () => 'k') }));
    await body('addFaq', { topic: 'lift-timings', title: 'Lift timings', en: 'Always on.' });
    for (const bad of [
      { topic: 'Lift Timings', title: 't', en: 'e' },
      { topic: 'ok-topic', title: '', en: 'e' },
      { topic: 'ok-topic', title: 't', en: '' },
      { topic: 'ok-topic', title: 't', en: 'x'.repeat(1001) }
    ]) {
      await assert.rejects(body('addFaq', bad), `rejects ${JSON.stringify(bad).slice(0, 60)}`);
    }
    await assert.rejects(query('searchFaqs', { q: 'x'.repeat(81) }));
  });

  test('check-up answers: a known care group, a rating 1-5; the agent-only call id is stripped', async () => {
    const ok = (await body('submitCheckup', { group: 'cardiac', answers: { medicines: 'yes' }, rating: 5, agentCallId: 'sneaky' })) as Record<string, unknown>;
    assert.equal(ok.agentCallId, undefined);
    await assert.rejects(body('submitCheckup', { group: 'x', answers: {} }));
    await assert.rejects(body('submitCheckup', { group: 'general', answers: 'yes' }));
    await assert.rejects(body('submitCheckup', { group: 'general', answers: {}, rating: 6 }));
    await assert.rejects(body('reviewCheckup', { note: '' }));
    await assert.rejects(query('listCheckups', { tab: 'all' }));
  });

  test('the settings route passes every key through to save, so the service refuses an unknown one', async () => {
    const { controller, calls } = wired();
    const b = (await body('saveSettings', { staleHours: 10, sneaky: true })) as never;
    assert.deepEqual({ ...(b as object) }, { staleHours: 10, sneaky: true }, 'the pipe strips nothing');
    await controller.saveSettings(USER, b);
    assert.deepEqual(calls[0], ['settings.save', [ACTOR, { staleHours: 10, sneaky: true }]]);
  });

  test('routes pass the path id and the acting user to the service', async () => {
    const { controller, calls } = wired();
    await controller.sendUpdate(USER, { id: ID });
    await controller.handOn(USER, { id: ID }, { ticketType: 'billing', note: 'n' } as never);
    await controller.saveContact(USER, { patientId: ID }, { via: 'desk' } as never);
    await controller.reviewCheckup(USER, { id: ID }, { note: 'seen' });
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['sendNow', 'handOn', 'saveContact', 'review']
    );
    assert.deepEqual(calls[0][1], [ACTOR, ID]);
    assert.deepEqual(calls[1][1], [ACTOR, ID, 'billing', 'n']);
    assert.deepEqual(calls[2][1], [ACTOR, ID, { via: 'desk' }]);
    assert.deepEqual(calls[3][1], [ACTOR, ID, 'seen']);
  });
});
