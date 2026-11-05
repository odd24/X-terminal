import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { snapshot, digest, firstDifference } from './Screen-Comparison.mjs';
import headless from '@xterm/headless';

// The unmodified locked reference is used throughout, including known bugs.
const write = text => ({ kind: 'write', text });
const resize = (rows, cols) => ({ kind: 'resize', rows, cols });
const numbered = (count, wide = false) => Array.from({ length: count }, (_, i) =>
  `\x1b[${i % 2 ? '32' : '31'}m${String(i).padStart(3, '0')}-${wide ? '中文ab界e\u0301末' : 'abcdefghijklmnop'}\x1b[0m\r\n`).join('') + 'end';
const fixtures = [
  { name: 'empty-height-width-bounds', rows: 1, cols: 2, steps: [resize(200, 500), resize(1, 2)] },
  { name: 'styled-wide-combining', rows: 4, cols: 12, steps: [write('\x1b[1;3;4;7;38;2;12;34;56;48;5;123m中e\u0301文abcdef界\x1b[0m\r\nnext'), resize(4, 5), resize(6, 20), resize(2, 3), resize(4, 12)] },
  { name: 'explicit-spaces-and-hard-lines', rows: 3, cols: 10, steps: [write('ab  cd  ef  gh\r\nx  \r\nlast\r\nend'), resize(3, 4), resize(5, 18), resize(2, 6)] },
  { name: 'wide-edge-padding', rows: 3, cols: 5, steps: [write('abcd中中文\r\nend'), resize(3, 3), resize(4, 12), write('\r\n后续中')] },
  { name: 'history-height-growth-shrink', rows: 4, cols: 12, steps: [write(numbered(20)), resize(10, 6), resize(2, 6), resize(8, 16), write('\r\nnew')] },
  { name: 'wide-history-height', rows: 4, cols: 12, steps: [write(numbered(30, true)), resize(1, 5), resize(15, 20), resize(3, 8)] },
  { name: 'capacity-before-ring-origin', rows: 4, cols: 12, steps: [write(numbered(257)), resize(4, 6), resize(4, 2), resize(4, 40)] },
  { name: 'capacity-nonzero-ring-origin', rows: 4, cols: 12, steps: [write(numbered(258)), resize(4, 6), resize(4, 2), resize(4, 40)] },
  { name: 'retired-history-and-height', rows: 4, cols: 12, steps: [write(numbered(600)), resize(200, 12), resize(1, 12), resize(4, 12)] },
  { name: 'wide-capacity', rows: 3, cols: 12, steps: [write(numbered(600, true)), resize(3, 5), resize(8, 20), resize(2, 8)] },
  { name: 'maximum-column-roundtrip', rows: 4, cols: 12, steps: [write(numbered(4, true)), resize(4, 2), resize(4, 500), resize(1, 2), resize(8, 12)] },
  { name: 'alternate-and-background-history', rows: 4, cols: 12, steps: [write(numbered(12)), write('\x1b[?1049h替代abcdefghijk'), resize(6, 5), write('\x1b[?1049l'), resize(3, 16)] },
  { name: 'saved-cursor-after-height', rows: 4, cols: 12, steps: [write(numbered(8) + '\x1b7'), resize(8, 6), resize(2, 15), write('\x1b8!')] },
];
fs.mkdirSync('artifacts', { recursive: true });
const fixturePath = 'artifacts/P11.7-history-fixtures.json';
fs.writeFileSync(fixturePath, JSON.stringify(fixtures));
const rust = JSON.parse(execFileSync('cargo', ['run', '--quiet', '--locked', '-p', 'session-core', '--example', 'history_probe', '--', fixturePath], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
const report = [];
const before = JSON.parse(fs.readFileSync('docs/evidence/P11.7-history-baseline.json', 'utf8'));
const remainingDifferences = new Map([
  ['capacity-nonzero-ring-origin/3', 'BUG-001: locked reference negative-index capacity behavior'],
  ['capacity-nonzero-ring-origin/4', 'BUG-001: locked reference negative-index capacity behavior'],
]);
for (const [index, fixture] of fixtures.entries()) {
  const term = new headless.Terminal({ rows: fixture.rows, cols: fixture.cols, scrollback: 512, allowProposedApi: true });
  try {
    const snapshots = [snapshot(term)];
    for (const action of fixture.steps) {
      if (action.kind === 'resize') term.resize(action.cols, action.rows);
      else {
        const bytes = new TextEncoder().encode(action.text);
        for (let offset = 0; offset < bytes.length; offset += 31) term.write(bytes.subarray(offset, offset + 31));
        await new Promise(resolve => term.write('', resolve));
      }
      snapshots.push(snapshot(term));
    }
    assert.equal(rust[index].name, fixture.name);
    assert.equal(rust[index].snapshots.length, snapshots.length);
    const steps = snapshots.map((reference, step) => {
      const candidate = rust[index].snapshots[step];
      const difference = firstDifference(reference, candidate);
      assert.equal(difference === null, digest(reference) === digest(candidate), 'comparison and canonical digest must agree');
      assert.equal(digest(reference), before.report[index].steps[step].xtermSha256, 'locked reference must remain unchanged');
      const reason = remainingDifferences.get(`${fixture.name}/${step}`);
      if (!process.argv.includes('--before')) assert.equal(!!difference, !!reason, `${fixture.name}/${step}: unexpected compatibility change`);
      return { step, result: difference ? 'KNOWN_DIFFERENCE' : 'MATCH', xtermSha256: digest(reference), vt100Sha256: digest(candidate), firstDifference: difference,
        ...(!process.argv.includes('--before') && reason ? { reason } : {}) };
    });
    fs.writeFileSync(`artifacts/P11.7-history-${fixture.name}.json`, JSON.stringify({ fixture, xterm: snapshots, vt100: rust[index].snapshots }));
    report.push({ name: fixture.name, steps });
  } finally { term.dispose(); }
}
const evidence = { schema: 1, reference: '@xterm/headless 6.0.0 (unmodified)', scrollback: 512, chunkBytes: 31,
  wrapConvention: 'outgoing: next retained row isWrapped; final row has no successor', compared: ['all retained rows', 'visible columns including empty cells', 'soft wrap', 'cell text/width', 'foreground/background', 'bold/dim/italic/underline/inverse', 'viewport dimensions/history/cursor/alternate'], fixturesSha256: digest(fixtures), report };
fs.writeFileSync('artifacts/P11.7-history-comparison.json', JSON.stringify(evidence, null, 2) + '\n');
const baselinePath = process.argv.includes('--before') ? 'docs/evidence/P11.7-history-baseline.json' : 'docs/evidence/P11.7-history-local4.json';
if (process.argv.includes('--record')) fs.writeFileSync(baselinePath, JSON.stringify(evidence, null, 2) + '\n');
else assert.deepEqual(evidence, JSON.parse(fs.readFileSync(baselinePath, 'utf8')), 'full history evidence changed: investigate before updating');
const steps = report.flatMap(row => row.steps);
console.log(`Full history: ${fixtures.length} fixtures, ${steps.filter(s => s.result === 'MATCH').length} matching snapshots, ${steps.filter(s => s.result === 'KNOWN_DIFFERENCE').length} known differences (not compatibility passes).`);
for (const row of report) console.log(`${row.name}: ${row.steps.filter(s => s.result === 'KNOWN_DIFFERENCE').map(s => `${s.step}:${s.firstDifference.path}`).join(', ') || 'all match'}`);
