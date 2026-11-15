import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PatientSupportModule } from './support.module';

describe('PatientSupportModule providers', () => {
  test('every constructor parameter has a real type or an @Inject token (Nest can resolve it at boot)', () => {
    const providers: any[] = Reflect.getMetadata('providers', PatientSupportModule);
    const controllers: any[] = Reflect.getMetadata('controllers', PatientSupportModule);
    assert.ok(providers.length > 5);
    assert.equal(controllers.length, 1);
    const bad: string[] = [];
    for (const p of [...providers, ...controllers]) {
      if (typeof p !== 'function') continue;
      const types: any[] = Reflect.getMetadata('design:paramtypes', p) ?? [];
      const injected = new Set<number>(((Reflect.getMetadata('self:paramtypes', p) ?? []) as { index: number }[]).map((x) => x.index));
      types.forEach((t, i) => {
        if ((t === Object || t === undefined) && !injected.has(i)) bad.push(`${p.name}[${i}]`);
      });
    }
    assert.deepEqual(bad, []);
  });
});
