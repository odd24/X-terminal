import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import headless from '@xterm/headless';

const fixturesPath = 'tests/fixtures/terminal-replay.json';
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
    await new Promise(resolve => term.write(bytes.subarray(offset, end), resolve));
    offset = end;
  }
  if (fixture.resize) term.resize(fixture.resize.cols, fixture.resize.rows);
  const buffer = term.buffer.active;
  const lines = Array.from({ length: term.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '');
  while (lines.at(-1) === '') lines.pop();
  const snapshot = { name: fixture.name, contents: lines.join('\n'), cursor: [buffer.cursorY, buffer.cursorX], alternate: buffer.type === 'alternate' };
  const expected = rust.find(result => result.name === fixture.name);
  assert.ok(snapshot.contents.includes(fixture.contains), fixture.name);
  if (fixture.expectDifference) assert.notDeepEqual(snapshot, expected, fixture.name);
  else assert.deepEqual(snapshot, expected, fixture.name);
  report.push({ xterm: snapshot, vt100: expected, result: fixture.expectDifference ? 'KNOWN_DIFFERENCE' : 'PASS' });
  term.dispose();
}
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/P02-screen-comparison.json', JSON.stringify(report, null, 2) + '\n');
console.log(`PASS: ${report.filter(row => row.result === 'PASS').length} matching fixtures; ${report.filter(row => row.result === 'KNOWN_DIFFERENCE').length} documented resize/reflow difference.`);
