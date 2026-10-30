import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
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
