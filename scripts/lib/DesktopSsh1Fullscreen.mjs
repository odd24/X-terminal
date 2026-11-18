import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { delay } from './DesktopHarness.mjs';
import { terminalInput } from './DesktopKeyboard.mjs';

const run = promisify(execFile);
const options = { windowsHide: true, encoding: 'utf8', timeout: 5000 };
const primary = 'P13_PRIMARY_MARKER';
const exitMarker = 'P13_AFTER_LESS exit=0';
const line = /^P13-L(\d{2}) Sample 中文行$/u;
const readPackets = peer => [...peer.wire.matchAll(/^conn#0: P04 SSH1_CMSG_WINDOW_SIZE (\d+) (\d+) (\d+) (\d+)\r?$/gm)]
  .map(match => match.slice(1).map(Number));

async function waitFor(read, description) {
  for (let i = 0; i < 120; i++) {
    const result = await read();
    if (result) return result;
    await delay(30);
  }
  throw new Error(description);
}

export async function verifyDesktopSsh1Fullscreen({ ui, keyboard, ref, executable, peer, servicePid, preview, pane, wsl, observation }) {
  const packaged = JSON.parse(await readFile(path.join(preview, 'manifest.json'), 'utf8'));
  const version = (await run('wsl.exe', [...wsl, '/usr/bin/less', '--version'], options)).stdout.split(/\r?\n/)[0];
  assert.match(version, /^less \d+/);
  const evidence = { result: 'FAIL', preview, packagedFromHead: packaged.packagedFromHead, ref, program: version };
  const osWindow = async (width, height, measureOnly = false) => JSON.parse((await run('pwsh', [
    '-NoProfile', '-File', 'scripts/lib/Resize-TestWindow.ps1',
    '-TargetProcessId', String(ui.app.pid), '-ExpectedExecutable', executable,
    '-Width', String(width), '-Height', String(height), '-PhysicalSize',
    ...(measureOnly ? ['-MeasureOnly'] : []),
  ], options)).stdout);
  const screen = async () => {
    const value = await ui.invoke('service_screen', { connection: ref });
    assert.deepEqual(value.connection, ref);
    assert.equal(value.gap_bytes, 0);
    assert.equal(value.decode_error_events, 0);
    return value;
  };
  const read = async cursor => {
    const page = await ui.invoke('service_read', { connection: ref, cursor });
    assert.deepEqual(page.connection, ref);
    assert.ok(!page.truncated && page.events.every(event => !event.gap_bytes));
    return { cursor: page.next_cursor, text: Buffer.from(page.events.flatMap(event => event.bytes)).toString('utf8') };
  };
  const painted = () => ui.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(pane + ' .xterm-rows > div')}),
    row => row.textContent.replaceAll('\\u00a0', ' ').trim())`);
  const visibleLines = async () => (await painted()).filter(text => line.test(text));
  const focus = () => ui.evaluate(`document.querySelector(${JSON.stringify(pane + ' ' + terminalInput)}).focus()`);
  const command = async text => {
    await focus();
    await ui.command('Input.insertText', { text });
    await keyboard.enter();
  };
  const viewportMatchesWindow = (view, window) => {
    assert.equal(view.dpr, window.dpi / 96);
    assert.ok(Math.abs(window.clientWidth - view.width * view.dpr) <= Math.ceil(view.dpr));
    assert.ok(Math.abs(window.clientHeight - view.height * view.dpr) <= Math.ceil(view.dpr));
  };
  try {
    evidence.beforeWindow = await osWindow(640, 480, true);
    const before = await observation.view();
    viewportMatchesWindow(before, evidence.beforeWindow);
    await waitFor(async () => {
      const current = await screen();
      return !current.alternate && current.rows === before.rows && current.cols === before.cols;
    }, 'primary screen must match the settled initial viewport');
    await command("printf '%s\\n' P13_PRIMARY_MARKER; printf 'P13_OWN_PTY '; /usr/bin/tty");
    await waitFor(async () => (await painted()).includes(primary), 'primary marker must paint as a full row');
    // The path is emitted by this exact isolated SSH1 shell. Do not persist it.
    const pty = await waitFor(async () => {
      const { text } = await read(1);
      return /\r\nP13_OWN_PTY (\/dev\/pts\/[0-9]{1,5})\r\n/.exec(text)?.[1];
    }, 'owned SSH1 shell must report its PTY');
    const ptySize = async () => {
      const { stdout } = await run('wsl.exe', [...wsl, '/usr/bin/stty', '-F', pty, 'size'], options);
      assert.match(stdout.trim(), /^\d+ \d+$/);
      return stdout.trim().split(' ').map(Number);
    };

    const programme = "/usr/bin/awk 'BEGIN { for(i=1;i<=80;i++) printf \"P13-L%02d Sample 中文行\\n\", i }' | " +
      '/usr/bin/env -i PATH=/usr/bin:/bin HOME="$HOME" TERM=xterm-256color LC_ALL=C.UTF-8 ' +
      'LESSSECURE=1 LESSHISTFILE=- LESSKEY=/dev/null LESSKEYIN=/dev/null /usr/bin/less -S';
    await command(programme);
    const initialRows = await waitFor(async () => {
      const visible = await visibleLines();
      return visible.length >= before.rows - 2 && visible;
    }, 'less must paint a full page of the synthetic bilingual text');
    const first = await screen();
    assert.equal(first.alternate, true);
    assert.equal((await painted()).includes(primary), false);
    assert.deepEqual(await ptySize(), [before.rows, before.cols]);
    assert.match(initialRows[0], /^P13-L01 /);
    assert.ok(initialRows.length < 80);
    evidence.initial = { cols: before.cols, rows: before.rows, alternate: true, visible: initialRows, pty: [before.rows, before.cols] };
    const initialPackets = readPackets(peer);
    const previousRequests = await observation.requests();
    const beforeResizeCursor = (await read(1)).cursor;
    const width = evidence.beforeWindow.width - 160;
    const height = evidence.beforeWindow.height - 110;
    assert.ok(width >= 640 && height >= 480 && width <= evidence.beforeWindow.availableWidth && height <= evidence.beforeWindow.availableHeight);

    evidence.afterWindow = await osWindow(width, height);
    assert.equal(evidence.afterWindow.hwnd, evidence.beforeWindow.hwnd);
    assert.equal(evidence.afterWindow.pid, evidence.beforeWindow.pid);
    assert.deepEqual([evidence.afterWindow.width, evidence.afterWindow.height], [width, height]);
    const after = await waitFor(async () => {
      const view = await observation.view();
      if (view.rows >= before.rows || view.cols >= before.cols) return;
      const current = await screen();
      if (!current.alternate || current.rows !== view.rows || current.cols !== view.cols) return;
      const visible = await visibleLines();
      if (visible.length < view.rows - 2 || visible.length >= initialRows.length) return;
      // Require fresh remote row text. Local clipping alone can reduce the
      // visible page and the pager may legitimately keep its last row.
      const { text } = await read(beforeResizeCursor);
      const repainted = [...new Set(text.match(/P13-L\d{2} Sample 中文行/gu) ?? [])];
      if (repainted.filter(row => visible.includes(row)).length < 2) return;
      return { ...view, visible, repainted };
    }, 'less must remain on the alternate screen and paint the resized page');
    evidence.resized = { cols: after.cols, rows: after.rows, alternate: true, visible: after.visible, repainted: after.repainted };
    viewportMatchesWindow(after, evidence.afterWindow);
    assert.ok(initialRows.filter(row => !after.visible.includes(row)).length >= 2);
    assert.equal(after.visible.length <= after.rows, true);
    evidence.resized.pty = await ptySize();
    assert.deepEqual(evidence.resized.pty, [after.rows, after.cols]);
    await waitFor(() => readPackets(peer).length > initialPackets.length, 'WSL must decode the window resize');
    const wire = readPackets(peer).slice(initialPackets.length);
    assert.deepEqual(wire, [[after.rows, after.cols, 0, 0]]);
    const requests = (await observation.requests()).slice(previousRequests.length);
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.deepEqual(request, { op: 'resize', connection: ref, request_id: request.request_id, cols: after.cols, rows: after.rows });
    const receipt = await ui.invoke('ssh_request', { request: { op: 'input_status', connection: ref, request_id: request.request_id } });
    assert.equal(receipt.request_id, request.request_id);
    assert.equal(receipt.state, 'PIPELINE_QUEUED');
    Object.assign(evidence.resized, { wire, receipt });
    await ui.screenshot(`P13-ssh1-less-resized-${ref.connection_id}.png`);

    await focus();
    await keyboard.key('q', 'KeyQ', 81, { text: 'q' });
    await waitFor(async () => !(await screen()).alternate && (await painted()).includes(primary),
      'q must restore the primary screen and its original marker');
    evidence.primaryRestored = true;
    await command("printf 'P13_AFTER_LESS exit=%s\\n' \"$?\"");
    await waitFor(async () => (await painted()).includes(exitMarker), 'original shell must print exit status 0');
    evidence.shellMarker = exitMarker;
    await command('exit');
    const exit = await peer.done;
    assert.ok(exit.signal === null && [0, 124].includes(exit.code));
    assert.match(peer.wire, /^conn#0: Client sent exit confirmation\r?$/m);
    const remaining = (await run('pwsh', ['-NoProfile', '-Command',
      `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${servicePid} AND Name='ssh1-helper.exe'").Count`], options)).stdout.trim();
    assert.equal(remaining, '0');
    Object.assign(evidence, { result: 'PASS', fixtureExit: exit.code, helpersRemaining: 0 });
  } finally {
    await writeFile(`artifacts/P13-ssh1-less-fullscreen-${ref.connection_id}.json`, JSON.stringify(evidence, null, 2) + '\n');
  }
  console.log('PASS isolated SSH1 less alternate screen, real resize, primary restoration and shell exit');
}
