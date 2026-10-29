import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BadRequestException, HttpException, Logger, NotFoundException } from '@nestjs/common';
import { AllExceptionsFilter } from './http-exception.filter';

function run(exception: unknown) {
  const filter = new AllExceptionsFilter({ get: () => false } as never);
  (filter as unknown as { logger: Logger }).logger = { error() {} } as never;
  let status = 0;
  let body: Record<string, unknown> = {};
  const response = { status: (s: number) => ((status = s), { json: (b: Record<string, unknown>) => (body = b) }) };
  const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ url: '/api/x' }) }) };
  filter.catch(exception, host as never);
  return { status, body };
}

describe('AllExceptionsFilter', () => {
  test('passes code, attemptsLeft, resendAfterSeconds and token through', () => {
    const token = { label: 'G-001' };
    const { status, body } = run(new HttpException({ message: 'Wait', code: 'OTP_WAIT', attemptsLeft: 2, resendAfterSeconds: 9, token }, 429));
    assert.equal(status, 429);
    assert.equal(body.message, 'Wait');
    assert.equal(body.code, 'OTP_WAIT');
    assert.equal(body.attemptsLeft, 2);
    assert.equal(body.resendAfterSeconds, 9);
    assert.deepEqual(body.token, token);
    assert.equal(body.success, false);
  });

  test('leaves other exceptions in the usual shape, without extra keys', () => {
    const { body } = run(new NotFoundException('Nope'));
    assert.equal(body.message, 'Nope');
    for (const key of ['code', 'attemptsLeft', 'resendAfterSeconds', 'token']) assert.equal(key in body, false);
    assert.deepEqual(run(new BadRequestException(['a', 'b'])).body.message, ['a', 'b']);
  });

  test('ignores extra fields that are not in the response object', () => {
    const { body } = run(new HttpException('plain', 400));
    assert.equal(body.message, 'plain');
    assert.equal('code' in body, false);
  });
});
