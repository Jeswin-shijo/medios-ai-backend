import 'reflect-metadata';
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { KioskRegisterDto } from './reception.dto';

const pipe = new ValidationPipe({ whitelist: true, transform: true });
const run = <T>(metatype: new () => T, value: unknown) => pipe.transform(value, { type: 'body', metatype }) as Promise<T>;

describe('Reception DTOs', () => {
  test("the kiosk's registration takes a name of up to 80 letters, as the service does", async () => {
    const person = { phone: '9876543210', gender: 'Female', age: 30 };
    await run(KioskRegisterDto, { ...person, name: 'R'.repeat(80) });
    await assert.rejects(
      () => run(KioskRegisterDto, { ...person, name: 'R'.repeat(81) }),
      (e: BadRequestException) => {
        assert.deepEqual((e.getResponse() as { message: string[] }).message, ['Enter the full name (2 to 80 letters).']);
        return true;
      },
    );
  });

  test("no kiosk DTO shares its class name with another module's (Swagger refuses duplicate schemas)", () => {
    const modules = join(__dirname, '..', '..');
    const namesIn = (dir: string) =>
      readdirSync(dir)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
        .flatMap((f) => [...readFileSync(join(dir, f), 'utf8').matchAll(/export class (\w+)/g)].map((m) => m[1]));
    const others = new Set(
      readdirSync(modules)
        .filter((mod) => mod !== 'reception' && existsSync(join(modules, mod, 'dto')))
        .flatMap((mod) => namesIn(join(modules, mod, 'dto'))),
    );
    const kiosk = namesIn(__dirname);
    assert.ok(kiosk.includes('KioskRegisterDto'));
    assert.deepEqual(kiosk.filter((name) => others.has(name)), []);
  });
});
