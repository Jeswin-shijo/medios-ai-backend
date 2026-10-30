import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CoordinatorController } from './coordinator.controller';
import { eventFor, type CoordinatorEvent } from './coordinator-events';
import { UserRole } from '../users/schemas/user.schema';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';

const ev = (from: CoordinatorEvent['from']): CoordinatorEvent => ({
  kind: 'message',
  id: 'm1',
  caseId: 'c1',
  from,
  to: ['bed'],
  summary: 'MHK1 in bed A-1',
});
const reduced = (from: CoordinatorEvent['from']) => ({ kind: 'message', from });

describe('eventFor (live stream filter, Y42)', () => {
  test('a pharmacist gets pharmacy and lab events in full, and others reduced', () => {
    assert.deepEqual(eventFor(UserRole.PHARMACIST, ev('pharmacy')), ev('pharmacy'));
    assert.deepEqual(eventFor(UserRole.PHARMACIST, ev('lab')), ev('lab'));
    assert.deepEqual(eventFor(UserRole.PHARMACIST, ev('er')), reduced('er'));
  });

  test('a lab user gets lab in full, and pharmacy reduced', () => {
    assert.deepEqual(eventFor(UserRole.LAB, ev('lab')), ev('lab'));
    assert.deepEqual(eventFor(UserRole.LAB, ev('pharmacy')), reduced('pharmacy'));
  });

  test('an event with no source agent is reduced for those roles', () => {
    const e: CoordinatorEvent = { kind: 'rule', id: 'r1', summary: 'x' };
    assert.deepEqual(eventFor(UserRole.LAB, e), { kind: 'rule', from: undefined });
  });

  test('a nurse gets everything in full', () => {
    assert.deepEqual(eventFor(UserRole.NURSE, ev('er')), ev('er'));
    assert.deepEqual(eventFor(UserRole.NURSE, ev('pharmacy')), ev('pharmacy'));
  });

  test('the stream route admits pharmacist and lab', () => {
    const roles: UserRole[] = Reflect.getMetadata(ROLES_KEY, CoordinatorController.prototype.stream);
    assert.ok(roles.includes(UserRole.PHARMACIST));
    assert.ok(roles.includes(UserRole.LAB));
    assert.ok(roles.includes(UserRole.NURSE));
  });
});
