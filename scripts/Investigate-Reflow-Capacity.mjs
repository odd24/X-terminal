// P11.7 investigation only. Never imported by the product or compatibility runner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import headless from '@xterm/headless';

const widths = [6, 2, 500, 2, 500, 12];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const textFor = count => Array.from({ length: count }, (_, i) => `${String(i).padStart(3, '0')}-abcdefghijklmnop\r\n`).join('') + 'end';
const packageInfo = JSON.parse(fs.readFileSync('node_modules/@xterm/headless/package.json'));
assert.equal(packageInfo.version, '6.0.0');
const sourceMap = JSON.parse(fs.readFileSync('node_modules/@xterm/headless/lib-headless/xterm-headless.js.map'));
const sources = ['common/buffer/Buffer.ts', 'common/CircularList.ts'].map(suffix => {
  const index = sourceMap.sources.findIndex(name => name.endsWith(suffix));
  assert.ok(index >= 0, suffix);
  const source = sourceMap.sourcesContent[index];
  assert.equal(source, fs.readFileSync(`node_modules/@xterm/xterm/src/${suffix}`, 'utf8'), 'headless source map must match the inspected xterm source');
  return { path: suffix, sha256: sha256(source) };
});

async function reference(count, { guard = false, scrollback = 512, steps = widths, text = textFor(count) } = {}) {
  const term = new headless.Terminal({ cols: 12, rows: 4, scrollback, allowProposedApi: true });
  try {
    await new Promise(resolve => term.write(text, resolve));
    // Private interfaces are deliberately confined to this version-pinned diagnostic.
    const buffer = term._core._bufferService.buffer;
    const lines = buffer.lines;
    const active = lines.get(buffer.ybase + buffer.y);
    const snapshot = () => ({
      contents: Array.from({ length: 4 }, (_, i) => lines.get(buffer.ybase + i).translateToString(true, 0, term.cols)).join('\n'),
      cursor: [buffer.y, buffer.x],
      alternate: false,
      base: buffer.ybase,
      length: lines.length,
      ringStart: lines._startIndex,
      activeRowPreserved: lines.get(buffer.ybase + buffer.y) === active,
      activeRowWrapped: lines.get(buffer.ybase + buffer.y).isWrapped
    });
    const initial = snapshot();
    const negativeWrites = [];
    const set = lines.set;
    let currentCols;
    lines.set = function (index, row) {
      if (index < 0) {
        const physicalIndex = (this._startIndex + index) % this.maxLength;
        negativeWrites.push({
          cols: currentCols, index, physicalIndex,
          aliasesActiveSlot: physicalIndex === (this._startIndex + buffer.ybase + buffer.y) % this.maxLength,
          contents: row.translateToString(true, 0, currentCols), wrapped: row.isWrapped,
          suppressedForDiagnostic: guard
        });
        // Counterfactual experiment only; official comparisons always use the unmodified package.
        if (guard) return;
      }
      return set.call(this, index, row);
    };
    const states = [];
    for (currentCols of steps) {
      term.resize(currentCols, 4);
      states.push({ cols: currentCols, ...snapshot() });
    }
    return { count, scrollback, inputBytes: Buffer.byteLength(text), inputSha256: sha256(text), initial, states, negativeWrites };
  } finally {
    term.dispose();
  }
}

// Exhaustive only in this fixed input family, not a claim of global minimality.
let firstAffected;
for (let count = 1; count <= 258; count++) {
  const result = await reference(count, { steps: [6, 2] });
  if (result.states.at(-1).contents.split('\n').at(-1) !== 'en') {
    firstAffected = count;
    break;
  }
}
assert.equal(firstAffected, 258);
const unchanged = await Promise.all([257, 258, 600].map(count => reference(count)));
const guarded = await Promise.all([257, 258, 600].map(count => reference(count, { guard: true })));
const tinyText = 'ABCDEFGHIJKLMNOPQRST\r\n'.repeat(2) + 'end';
const tinyReferenceOnly = { text: tinyText, ...await reference(2, { scrollback: 0, steps: [6, 2], text: tinyText }) };
assert.equal(tinyReferenceOnly.states.at(-1).activeRowPreserved, false);
assert.equal(tinyReferenceOnly.states.at(-1).contents.split('\n').at(-1), 'MN');
for (const result of unchanged) {
  const affected = result.count >= 258;
  const write = result.negativeWrites.find(event => event.cols === 2);
  assert.ok(write);
  assert.equal(write.index, -1);
  assert.equal(write.aliasesActiveSlot, affected);
  assert.equal(result.states[1].activeRowPreserved, !affected);
  assert.equal(result.states[1].activeRowWrapped, affected);
  assert.equal(result.states[1].contents, `kl\nmn\nop\n${affected ? 'ef' : 'en'}`);
}

fs.mkdirSync('artifacts', { recursive: true });
// Each prefix is independently replayed by the production Screen wrapper.
const fixtures = unchanged.flatMap(result => widths.map((cols, index) => ({
  name: `capacity-${result.count}-step-${index + 1}`, rows: 4, cols: 12,
  text: textFor(result.count), chunkSizes: [4096], physical: true,
  steps: widths.slice(0, index + 1).map(cols => ({ kind: 'resize', cols, rows: 4 }))
})));
const fixturePath = 'artifacts/P11.7-B-capacity-fixtures.json';
fs.writeFileSync(fixturePath, JSON.stringify(fixtures, null, 2) + '\n');
const candidate = JSON.parse(execFileSync('cargo', ['run', '--quiet', '--locked', '-p', 'session-core', '--example', 'screen_probe', '--', fixturePath], { encoding: 'utf8' }));
const comparisons = [];
for (let group = 0; group < unchanged.length; group++) {
  for (let step = 0; step < widths.length; step++) {
    const actual = candidate[group * widths.length + step];
    const { name, ...view } = actual;
    const { contents, cursor, alternate } = guarded[group].states[step];
    assert.deepEqual(view, { contents, cursor, alternate }, `${name}: diagnostic guard disagrees with the service`);
    const ref = unchanged[group].states[step];
    const matches = JSON.stringify([view.contents, view.cursor]) === JSON.stringify([ref.contents, ref.cursor]);
    assert.equal(matches, unchanged[group].count === 257 || step === 0, `${name}: official reference result changed`);
    comparisons.push({ name, candidate: view, unmodifiedReference: { contents: ref.contents, cursor: ref.cursor, alternate: ref.alternate }, result: matches ? 'MATCH' : 'KNOWN_DIFFERENCE', diagnosticGuardMatchesCandidate: true });
  }
}
const report = {
  kind: 'INVESTIGATION_NOT_COMPATIBILITY_PASS',
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  reference: { version: packageInfo.version, commit: packageInfo.commit, sources },
  family: { cols: 12, rows: 4, scrollback: 512, record: 'NNN-abcdefghijklmnop\\r\\n', suffix: 'end', widths },
  reduction: { originalRecords: 600, firstAffectedInExhaustiveRange1Through258: firstAffected, originalInputBytes: Buffer.byteLength(textFor(600)), reducedInputBytes: Buffer.byteLength(textFor(258)), globalMinimalityClaimed: false },
  unchanged, guardedDiagnosticOnly: guarded, tinyReferenceOnly, comparisons,
  conclusion: 'The locked xterm smaller-reflow batch inserts write index -1. With nonzero ring start this aliases the active slot, replacing end with ef and marking it wrapped. Wider reflow then skips its merged cursor group. Guard suppression is diagnostic only and is never a compatibility oracle or a dependency patch.'
};
fs.writeFileSync('artifacts/P11.7-B-capacity-investigation.json', JSON.stringify(report, null, 2) + '\n');
console.log(`P11.7 investigation: first affected family member 258/600; ${comparisons.filter(row => row.result === 'MATCH').length}/18 unmodified-reference matches, ${comparisons.filter(row => row.result === 'KNOWN_DIFFERENCE').length} known differences. Diagnostic guard agrees with service in all 18 prefixes; not compatibility passes.`);
