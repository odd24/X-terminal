import fs from 'node:fs';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import headless from '@xterm/headless';

const fixturesPath = process.argv[2] ?? 'tests/fixtures/terminal-replay.json';
const reflow = fixturesPath.endsWith('terminal-reflow.json');
const baselinePath = 'docs/evidence/P11.7-reflow-before.json';
const baseline = reflow && fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : undefined;
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
const rust = JSON.parse(execFileSync('cargo', ['run', '--quiet', '--locked', '-p', 'session-core', '--example', 'screen_probe', '--', fixturesPath], { encoding: 'utf8' }));
const report = [];
for (const fixture of fixtures) {
  const term = new headless.Terminal({ cols: fixture.cols, rows: fixture.rows, scrollback: 512, allowProposedApi: true });
  const bytes = new TextEncoder().encode(fixture.text);
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const end = Math.min(offset + fixture.chunkSizes[index++ % fixture.chunkSizes.length], bytes.length);
    term.write(bytes.subarray(offset, end));
    offset = end;
  }
  await new Promise(resolve => term.write('', resolve));
  if (fixture.resize) term.resize(fixture.resize.cols, fixture.resize.rows);
  for (const step of fixture.steps ?? []) {
    if (step.kind === 'resize') term.resize(step.cols, step.rows);
    else if (step.kind === 'write') await new Promise(resolve => term.write(step.text, resolve));
    else throw new Error(`unknown step ${step.kind}`);
  }
  const buffer = term.buffer.active;
  const lines = Array.from({ length: term.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true, 0, term.cols) ?? '');
  while (lines.at(-1) === '') lines.pop();
  const snapshot = { name: fixture.name, contents: lines.join('\n'), cursor: [buffer.cursorY, buffer.cursorX], alternate: buffer.type === 'alternate' };
  const expected = rust.find(result => result.name === fixture.name);
  assert.ok(snapshot.contents.includes(fixture.contains), fixture.name);
  if (reflow) {
    if (baseline) {
      const previous = baseline.find(result => result.xterm.name === fixture.name);
      assert.deepEqual(snapshot, previous.xterm, `${fixture.name}: reference changed`);
      assert.deepEqual(expected, previous.vt100, `${fixture.name}: candidate changed`);
    }
  } else if (fixture.expectDifference) assert.notDeepEqual(snapshot, expected, fixture.name);
  else assert.deepEqual(snapshot, expected, fixture.name);
  report.push({ xterm: snapshot, vt100: expected, result: isDeepStrictEqual(snapshot, expected) ? 'PASS' : 'KNOWN_DIFFERENCE' });
  term.dispose();
}
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync(reflow ? 'artifacts/P11.7-reflow-comparison.json' : 'artifacts/P02-screen-comparison.json', JSON.stringify(report, null, 2) + '\n');
console.log(`Differential report: ${report.filter(row => row.result === 'PASS').length} matching fixtures; ${report.filter(row => row.result === 'KNOWN_DIFFERENCE').length} documented resize/reflow differences (not compatibility passes).`);
