import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ErVisitsService } from './er-visits.service';
import { ErModule } from './er.module';

describe('ErModule', () => {
  test('ErModule exports ErVisitsService', () => {
    const exported = Reflect.getMetadata('exports', ErModule) as unknown[];
    assert.ok(exported.includes(ErVisitsService));
  });
});
