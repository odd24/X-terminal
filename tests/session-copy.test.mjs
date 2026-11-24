import assert from 'node:assert/strict';
import test from 'node:test';
import { PaneLayout } from '../apps/desktop/src/pane-layout.ts';
import { SessionCopy, copyRouteCurrent } from '../apps/desktop/src/session-copy.ts';

const source = { connection_id: 'source', generation: 1, protocol: 'SSH2', state: 'CONNECTED' };
const child = { ...source, connection_id: 'child' };
const read = { key: 'second', owner: 'service' };

test('a copy keeps its original pane and rejects a closed source or changed generation', () => {
  const layout = new PaneLayout();
  layout.addPane('first', 'horizontal', false);
  layout.move(source, 'second', [source, child]);
  layout.focus('first');
  const route = { ...read, source };
  assert.equal(copyRouteCurrent(route, 'service', layout, [source], true), true);
  assert.equal(copyRouteCurrent(route, 'restarted', layout, [source], true), false);
  assert.equal(copyRouteCurrent(route, 'service', layout, [{ ...source, generation: 2 }], true), false);
  assert.equal(copyRouteCurrent(route, 'service', layout, [source], false), false);
  layout.closePane('second');
  assert.equal(copyRouteCurrent(route, 'service', layout, [source], true), false);
});

test('read slots and results belong to the original copy through cancellation and replacement', () => {
  const copies = new SessionCopy();
  const another = { ...read, key: 'first', detachedId: 'native-copy' };
  assert.equal(copies.startRead(read), true);
  assert.equal(copies.startRead(another), false);
  assert.equal(copies.open(another, source), undefined);
  const original = copies.open(read, source);
  copies.finishRead(read);
  assert.equal(copies.acceptResult(original, source), false);
  assert.equal(copies.acceptResult(original, child), true);
  assert.equal(copies.acceptResult(original, child), false);
  assert.equal(copies.close(original, false), true);
  assert.equal(copies.takePlacement(read.owner, [source, child]), undefined);
  assert.equal(copies.startRead(another), true);
  assert.equal(copies.isReadingDetached(another.detachedId), true);
  copies.finishRead(read);
  const replacement = copies.open(another, source);
  assert.equal(replacement.key, 'first');
  assert.equal(copies.acceptResult(original, { ...child, generation: 2 }), false);
  assert.equal(copies.close(original, false), false);
  assert.equal(copies.acceptResult(replacement, child), true);
  assert.equal(copies.ownsResult(replacement, child), true);
  assert.equal(copies.takePlacement(read.owner, [source, child]), undefined);
});

test('successful placement waits for the exact child and is consumed once', () => {
  const copies = new SessionCopy();
  copies.startRead(read);
  const route = copies.open(read, source);
  copies.finishRead(read);
  copies.acceptResult(route, child);
  copies.close(route, true);
  assert.equal(copies.takePlacement(read.owner, [source, { ...child, protocol: 'SERIAL' }]), undefined);
  assert.deepEqual(copies.takePlacement(read.owner, [source, child]), { route, anchor: source, child });
  assert.equal(copies.takePlacement(read.owner, [source, child]), undefined);
});
