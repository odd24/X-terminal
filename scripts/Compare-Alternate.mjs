import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import headless from '@xterm/headless';
import fixtures from '../tests/fixtures/terminal-alternate.mjs';
import { snapshot, digest, firstDifference } from './Screen-Comparison.mjs';

const beforePath = 'docs/evidence/P11.7-alternate-before.json';
const afterPath = 'docs/evidence/P11.7-alternate-after.json';
const captureBefore = process.argv.includes('--capture-before');
if (captureBefore) assert.ok(!fs.existsSync(beforePath), 'never overwrite original evidence');
const before = captureBefore ? null : JSON.parse(fs.readFileSync(beforePath, 'utf8'));
fs.mkdirSync('artifacts', { recursive: true });
const fixturePath = 'artifacts/P11.7-alternate-fixtures.json';
fs.writeFileSync(fixturePath, JSON.stringify(fixtures));
const rust = JSON.parse(execFileSync('cargo', ['run', '--quiet', '--locked', '-p', 'session-core', '--example', 'history_probe', '--', fixturePath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const report = [];
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
      assert.equal(difference === null, digest(reference) === digest(candidate));
      if (before) {
        assert.equal(digest(reference), before.report[index].steps[step].xtermSha256, 'locked reference changed');
        assert.equal(difference, null, `${fixture.name}/${step}: ${JSON.stringify(difference)}`);
      }
      return { step, result: difference ? 'DIFFERENCE' : 'MATCH', xtermSha256: digest(reference), vt100Sha256: digest(candidate), firstDifference: difference };
    });
    report.push({ name: fixture.name, steps });
    fs.writeFileSync(`artifacts/P11.7-alternate-${fixture.name}.json`, JSON.stringify({ fixture, xterm: snapshots, vt100: rust[index].snapshots }));
  } finally { term.dispose(); }
}
const evidence = { schema: 1, reference: '@xterm/headless 6.0.0 (unmodified)', scrollback: 512, chunkBytes: 31, fixturesSha256: digest(fixtures), report };
if (before) assert.equal(evidence.fixturesSha256, before.fixturesSha256);
if (captureBefore) fs.writeFileSync(beforePath, JSON.stringify(evidence, null, 2) + '\n');
else if (process.argv.includes('--record')) fs.writeFileSync(afterPath, JSON.stringify(evidence, null, 2) + '\n');
else assert.deepEqual(evidence, JSON.parse(fs.readFileSync(afterPath, 'utf8')));
const steps = report.flatMap(r => r.steps);
console.log(`Alternate lifecycle: ${fixtures.length} fixtures, ${steps.filter(s => s.result === 'MATCH').length} matching / ${steps.filter(s => s.result === 'DIFFERENCE').length} differing snapshots.`);
for (const row of report) console.log(`${row.name}: ${row.steps.filter(s => s.firstDifference).map(s => `${s.step}:${s.firstDifference.path}`).join(', ') || 'all match'}`);
