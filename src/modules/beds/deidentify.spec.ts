import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deidentify } from './deidentify';

const who = {
  name: 'Arun Kumar',
  uhid: 'MHK202600011',
  phone: '9876543210',
  address: '12 Main St, Nagercoil',
  email: 'arun@x.in',
};

describe('deidentify', () => {
  test('removes name, uhid, phone, address and email but keeps clinical text', () => {
    const out = deidentify(
      'Arun Kumar (MHK202600011) ph 98765 43210, 12 Main St, Nagercoil, arun@x.in. Kumar is breathless.',
      who,
    );
    for (const s of ['Arun', 'Kumar', 'MHK202600011', '98765', 'Main St', 'arun@x.in']) {
      assert.ok(!out.includes(s), `still contains ${s}: ${out}`);
    }
    assert.ok(out.includes('breathless'));
  });

  test('removes other UHIDs, emails and long digit runs', () => {
    const out = deidentify('Ref MHK202600099, mail a.b@c.com, call 91-98765-00000 or 044 2345 6789', who);
    assert.ok(!/MHK\d/.test(out));
    assert.ok(!out.includes('a.b@c.com'));
    assert.ok(!/\d{5}/.test(out));
  });

  test('is case-insensitive and keeps short numbers', () => {
    const out = deidentify('ARUN says SpO2 89% on day 3', who);
    assert.ok(!out.includes('ARUN'));
    assert.ok(out.includes('89%') && out.includes('day 3'));
  });
});
