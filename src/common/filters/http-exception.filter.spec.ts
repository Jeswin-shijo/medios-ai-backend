import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BadRequestException, HttpException, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AllExceptionsFilter, redactUrl } from './http-exception.filter';

describe('redactUrl', () => {
  test('secret-looking query values are replaced; the rest is kept', () => {
    assert.equal(redactUrl('/api/calls/webhook/snapserve?token=abc123'), '/api/calls/webhook/snapserve?token=[redacted]');
    assert.equal(redactUrl('/api/x?a=1&secret=s3&Key=k&signature=zz&b=2'), '/api/x?a=1&secret=[redacted]&Key=[redacted]&signature=[redacted]&b=2');
    assert.equal(redactUrl('/api/x?api_key=k&access_token=t'), '/api/x?api_key=[redacted]&access_token=[redacted]');
    assert.equal(redactUrl('/api/patients?search=Rekha&limit=20'), '/api/patients?search=Rekha&limit=20');
    assert.equal(redactUrl('/api/health'), '/api/health');
  });
});

describe('AllExceptionsFilter', () => {
  test('the logged line and the error body never carry the webhook token', () => {
    const filter = new AllExceptionsFilter({ get: () => false } as any);
    const logged: string[] = [];
    (filter as any).logger = { error: (line: string) => logged.push(line) };
    let body: any;
    const response = { status: () => ({ json: (b: unknown) => (body = b) }) };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ url: '/api/calls/webhook/snapserve?token=the-real-secret-value' }),
      }),
    };
    filter.catch(new UnauthorizedException('Invalid webhook signature'), host as any);
    assert.equal(logged.length, 1);
    assert.ok(!logged[0].includes('the-real-secret-value'), logged[0]);
    assert.match(logged[0], /token=\[redacted\]/);
    assert.ok(!JSON.stringify(body).includes('the-real-secret-value'));
  });
});

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

describe('AllExceptionsFilter passes the kiosk fields through', () => {
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
