import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestId } from '../apps/desktop/src/request-id.ts';

test('request IDs preserve the supplied millisecond bucket, RFC variant and random uniqueness', () => {
  const stamp = 1793770000123;
  const ids = Array.from({ length: 10000 }, () => requestId(stamp));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(parseInt(id.replaceAll('-', '').slice(0, 12), 16), stamp);
  }
  assert.ok(requestId(stamp + 1) > ids[0]);
  assert.ok(requestId(stamp - 1) < ids[0]); // No hidden clock rewrite or retry.
  for (const invalid of [-1, NaN, Infinity, 0.5, 0x1000000000000]) assert.throws(() => requestId(invalid));
});
