import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedRecoveryExport, restoreRecoveryExport } from '../apps/desktop/src/log-recovery-export.ts';
import { checkedExport } from '../apps/desktop/src/log-export.ts';
const scope = { connection: { connection_id: '11111111-1111-4111-8111-111111111111', generation: 3 }, log_id: '22222222-2222-4222-8222-222222222222', request_id: '33333333-3333-7333-8333-333333333333' };
const done = () => ({ result: 'recovery_export', ...structuredClone(scope), phase: 'COMPLETED', failure: null, bytes: 1000, sha256: 'ab'.repeat(32), incomplete: true, recovered: { recovered_records: 2, recovered_raw_bytes: 10, recovered_gap_bytes: 0, next_cursor: 3, stop: { kind: 'TRUNCATED_RECORD', segment: 1, next_cursor: 3 } } });
test('recovery completion preserves explicit incomplete mode and exact scope; ordinary completion cannot substitute', () => {
  assert.equal(checkedRecoveryExport(done(), scope).incomplete, true);
  assert.throws(() => checkedExport(done(), scope));
  for (const edit of [v => v.result = 'export', v => v.incomplete = false, v => delete v.incomplete, v => v.connection.generation++, v => v.log_id = scope.request_id, v => v.request_id = scope.log_id, v => v.retained_records = 2, v => v.bytes = 0, v => v.sha256 = 'A'.repeat(64), v => v.failure = 'STORAGE']) {
    const value = done(); edit(value); assert.throws(() => checkedRecoveryExport(value, scope));
  }
});
test('recovery reports require safe totals, a real stop and consistent cursor, including empty end-of-available', () => {
  for (const key of ['recovered_records', 'recovered_raw_bytes', 'recovered_gap_bytes', 'next_cursor']) for (const bad of [null, undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2']) {
    const value = done(); value.recovered[key] = bad; assert.throws(() => checkedRecoveryExport(value, scope));
  }
  for (const edit of [v => v.recovered.stop = null, v => v.recovered.stop.kind = 'verified', v => v.recovered.stop.segment = 0, v => v.recovered.stop.next_cursor++, v => v.recovered.recovered_records = 3]) {
    const value = done(); edit(value); assert.throws(() => checkedRecoveryExport(value, scope));
  }
  const empty = done(); Object.assign(empty.recovered, { recovered_records: 0, recovered_raw_bytes: 0, next_cursor: 1, stop: { kind: 'END_OF_AVAILABLE', segment: 1, next_cursor: 1 } });
  assert.equal(checkedRecoveryExport(empty, scope).incomplete, true);
  for (const phase of ['QUEUED', 'RUNNING', 'CANCELLING', 'CANCELLED', 'FAILED', 'REMOVED']) {
    const value = { ...done(), phase, failure: phase === 'FAILED' ? 'STORAGE' : null };
    assert.throws(() => checkedRecoveryExport(value, scope));
    Object.assign(value, { recovered: null, bytes: null, sha256: null });
    assert.equal(checkedRecoveryExport(value, scope).recovered, null);
  }
});
test('restoring recovery IDs requires explicit mode and discards results, paths and permissions', () => {
  assert.deepEqual(restoreRecoveryExport(JSON.stringify({ ...done(), mode: 'RECOVERY', path: 'forbidden', confirmation: 'forbidden' })), scope);
  for (const value of [null, '{', 'x'.repeat(2049), JSON.stringify(scope), JSON.stringify({ ...scope, mode: 'NORMAL' }), JSON.stringify({ ...scope, mode: 'RECOVERY', connection: { ...scope.connection, generation: 0 } })]) assert.equal(restoreRecoveryExport(value), undefined);
});
