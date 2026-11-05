import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionCatalog } from '../apps/desktop/src/connection-catalog.ts';

test('display metadata rejects late reads after forgetting, reconnecting or changing service owner', () => {
  const catalog = new ConnectionCatalog();
  const first = { connection_id: 'same-profile-A', generation: 1, protocol: 'SSH2' };
  const second = { ...first, connection_id: 'same-profile-B' };
  catalog.retain('service-A', [first, second]);
  catalog.put('service-A', first, { profile_id: 'shared', encoding: 'gbk', challenge: { prompts: ['synthetic authentication context'] } });
  assert.deepEqual(catalog.get(first), { profile_id: 'shared', encoding: 'gbk' }, 'display cache excludes authentication context');
  catalog.put('service-A', second, { profile_id: 'shared', encoding: 'utf8' });
  assert.equal(catalog.get(first).encoding, 'gbk');
  assert.equal(catalog.get(second).encoding, 'utf8');
  const next = { ...first, generation: 2 };
  catalog.retain('service-A', [next]);
  assert.equal(catalog.size, 0);
  assert.equal(catalog.put('service-A', first, { profile_id: 'shared', encoding: 'gbk' }), false);
  assert.equal(catalog.put('service-A', second, { profile_id: 'shared', encoding: 'utf8' }), false);
  catalog.retain('service-B', [next]);
  assert.equal(catalog.put('service-A', next, { profile_id: 'shared', encoding: 'gbk' }), false);
  assert.equal(catalog.get(next), undefined);
});

test('long-running create/forget cycles retain only current service entries', () => {
  const catalog = new ConnectionCatalog();
  for (let cycle = 0; cycle < 2000; cycle++) {
    const connection = { connection_id: `new-${cycle}`, generation: 1, protocol: 'SERIAL' };
    catalog.retain('service', [connection]);
    assert.equal(catalog.put('service', connection, { profile_id: 'same-profile', encoding: 'utf8' }), true);
    assert.equal(catalog.size, 1);
  }
  catalog.retain('service', []);
  assert.equal(catalog.size, 0);
});
