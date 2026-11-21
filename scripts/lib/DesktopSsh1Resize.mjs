import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { delay } from './DesktopHarness.mjs';

const run = promisify(execFile);
const options = { windowsHide: true, encoding: 'utf8', timeout: 5000 };
const packets = peer => [...peer.wire.matchAll(/^conn#0: P04 SSH1_CMSG_WINDOW_SIZE (\d+) (\d+) (\d+) (\d+)\r?$/gm)]
  .map(match => match.slice(1).map(Number));

async function waitForResult(get, label) {
  for (let i = 0; i < 120; i++) {
    const result = await get();
    if (result) return result;
    await delay(25);
  }
  throw new Error(label);
}

export async function observeDesktopSsh1Sizes(ui) {
  await ui.evaluate(`(() => {
    const original=window.fetch;
    const measure=()=>{
      const [cols,rows]=document.querySelector('[aria-label="终端视口尺寸"]').textContent.match(/(\\d+)×(\\d+)/).slice(1).map(Number);
      return {cols,rows,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,
        terminalHeight:document.querySelector('.terminal')?.getBoundingClientRect().height??0,
        emptyHeight:document.querySelector('.terminal-empty')?.getBoundingClientRect().height??0,
        modal:!!document.querySelector('dialog:modal')};
    };
    const hook={original, requests:[], beforeDialog:measure(), measure};
    window.__p13ResizeObservation=hook;
    window.fetch=function(input,init) {
      if(new URL(String(input)).pathname==='/ssh_request') {
        const request=JSON.parse(init.body)?.request;
        if(request?.op==='start_fixed') hook.launch=measure();
        if(request?.op==='start_fixed'||request?.op==='resize') hook.requests.push(request);
      }
      return original.call(this,input,init);
    };
  })()`);
  return {
    requests: () => ui.evaluate('window.__p13ResizeObservation.requests'),
    layouts: () => ui.evaluate('({beforeDialog:window.__p13ResizeObservation.beforeDialog,launch:window.__p13ResizeObservation.launch})'),
    view: () => ui.evaluate('window.__p13ResizeObservation.measure()'),
    restore: () => ui.evaluate('window.fetch=window.__p13ResizeObservation.original;delete window.__p13ResizeObservation'),
  };
}

export async function verifyDesktopSsh1Resize({ ui, keyboard, ref, executable, peer, servicePid, preview, terminal, observation }) {
  const osWindow = async (width, height, measureOnly = false) => JSON.parse((await run('pwsh', [
    '-NoProfile', '-File', 'scripts/lib/Resize-TestWindow.ps1',
    '-TargetProcessId', String(ui.app.pid), '-ExpectedExecutable', executable,
    '-Width', String(width), '-Height', String(height), '-PhysicalSize',
    ...(measureOnly ? ['-MeasureOnly'] : []),
  ], options)).stdout);
  const view = observation.view;
  function verifyClient(window, viewport) {
    assert.equal(viewport.dpr, window.dpi / 96);
    assert.ok(Math.abs(window.clientWidth - viewport.width * viewport.dpr) <= Math.ceil(viewport.dpr));
    assert.ok(Math.abs(window.clientHeight - viewport.height * viewport.dpr) <= Math.ceil(viewport.dpr));
  }
  const readMarker = name => waitForResult(async () => {
    const page = await ui.invoke('service_read', { connection: ref, cursor: 1 });
    assert.deepEqual(page.connection, ref);
    const data = Buffer.from(page.events.flatMap(event => event.bytes)).toString('ascii');
    const match = new RegExp(`\\r\\n${name} (\\d+) (\\d+)\\r\\n`).exec(data);
    return match?.slice(1).map(Number);
  }, `PTY marker absent: ${name}`);
  const verifyReceipt = async (request, viewport) => {
    assert.match(request.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.deepEqual(request, { op: 'resize', connection: ref, request_id: request.request_id,
      cols: viewport.cols, rows: viewport.rows });
    const query = { op: 'input_status', connection: ref, request_id: request.request_id };
    const receipt = await waitForResult(async () => {
      const result = await ui.invoke('ssh_request', { request: query });
      return ['PENDING', 'DISPATCHING'].includes(result.state) ? undefined : result;
    }, 'original resize receipt must reach a terminal state');
    assert.deepEqual(receipt, { result: 'input', request_id: request.request_id,
      state: 'PIPELINE_QUEUED', pipeline_bytes: null, failure: null });
    return { query, receipt };
  };
  const before = await osWindow(640, 480, true);
  const readRequests = observation.requests;
  const starts = await waitForResult(async () => {
    const requests = await readRequests();
    return requests.length >= 2 ? requests : undefined;
  }, 'initial visible SSH1 viewport must synchronize once');
  assert.deepEqual(starts.map(request => request.op), ['start_fixed', 'resize']);
  const [start, initialResize] = starts;
  const initial = await view();
  const layouts = await observation.layouts();
  assert.equal(layouts.beforeDialog.modal, false);
  assert.equal(layouts.launch.modal, true);
  assert.equal(initial.modal, false);
  assert.deepEqual([layouts.beforeDialog.terminalHeight, layouts.beforeDialog.emptyHeight],
    [layouts.launch.terminalHeight, layouts.launch.emptyHeight]);
  assert.ok(layouts.launch.emptyHeight > 0 && initial.terminalHeight > layouts.launch.terminalHeight);
  assert.equal(initial.emptyHeight, 0);
  assert.deepEqual([start.rows, start.cols], [layouts.launch.rows, layouts.launch.cols]);
  assert.notDeepEqual([start.rows, start.cols], [initial.rows, initial.cols]);
  const { receipt: initialReceipt } = await verifyReceipt(initialResize, initial);
  await waitForResult(() => packets(peer).length > 0, 'initial viewport packet must reach the peer');
  const expectedInitialPacket = [[initial.rows, initial.cols, 0, 0]];
  assert.deepEqual(packets(peer), expectedInitialPacket);
  verifyClient(before, initial);
  const width = before.width - 160;
  const height = before.height - 110;
  assert.ok(width >= 640 && height >= 480 && width <= before.availableWidth && height <= before.availableHeight);
  const pauseList = await ui.interceptIpc({ command: 'service_list', mode: 'hold' });
  const tab = `[role="tab"][data-connection-id="${ref.connection_id}"]`;
  const pane = `.terminal-pane[data-active="true"][data-rendered-id="${ref.connection_id}"][data-rendered-generation="${ref.generation}"]`;
  try {
    await waitForResult(() => pauseList.count(), 'real service list response must be held during repeated selection');
    await ui.evaluate(`document.querySelector(${JSON.stringify(tab)}).click()`);
    await ui.waitFor(`!!document.querySelector(${JSON.stringify(pane)})`);
  } finally { await pauseList.restore(); }
  await delay(220);
  assert.deepEqual(await readRequests(), starts, 'reselecting the same tab must not duplicate the initial resize');
  assert.deepEqual(packets(peer), expectedInitialPacket);

  const initialScreen = await ui.invoke('service_screen', { connection: ref });
  assert.deepEqual(initialScreen.connection, ref);
  assert.deepEqual([initialScreen.rows, initialScreen.cols], [initial.rows, initial.cols]);
  await ui.evaluate(`document.querySelector(${JSON.stringify(terminal)}).focus()`);
  await ui.command('Input.insertText', { text: 'exec ./p04-pty-size' });
  await keyboard.enter();
  const initialPty = await readMarker('P04_PTY_INITIAL');
  assert.deepEqual(initialPty, [initial.rows, initial.cols], 'remote PTY must already match before the manual resize');
  const priorPackets = packets(peer);
  const after = await osWindow(width, height);
  assert.equal(after.hwnd, before.hwnd);
  assert.equal(after.pid, before.pid);
  assert.deepEqual([after.width, after.height], [width, height]);
  const updated = await waitForResult(async () => {
    const current = await view();
    return current.rows !== initial.rows && current.cols !== initial.cols && current;
  }, 'fit did not change terminal rows and columns');
  verifyClient(after, updated);
  const resizedPty = await readMarker('P04_PTY_SIGWINCH');
  assert.notDeepEqual(resizedPty, initialPty);
  assert.deepEqual(resizedPty, [updated.rows, updated.cols]);
  const exit = await peer.done;
  assert.ok(exit.signal === null && [0, 124].includes(exit.code));
  assert.match(peer.wire, /^conn#0: Client sent exit confirmation\r?$/m);
  const fresh = packets(peer).slice(priorPackets.length);
  assert.deepEqual(fresh, [[updated.rows, updated.cols, 0, 0]]);
  const requests = await readRequests();
  assert.deepEqual(requests.map(request => request.op), ['start_fixed', 'resize', 'resize']);
  const request = requests[2];
  assert.notEqual(request.request_id, initialResize.request_id);
  const { query, receipt } = await verifyReceipt(request, updated);
  const stale = { ...query, connection: { ...ref, generation: ref.generation + 1 } };
  assert.equal(await ui.evaluate(`window.__TAURI_INTERNALS__.invoke('ssh_request',${JSON.stringify({ request: stale })}).then(()=>'accepted',String)`), 'StaleGeneration');
  const screen = await ui.invoke('service_screen', { connection: ref });
  assert.deepEqual(screen.connection, ref);
  assert.deepEqual([screen.rows, screen.cols], resizedPty);
  const evidence = { result: 'PASS', preview, ref, before, after, layouts, initial, updated, start, initialResize, initialReceipt,
    noResizeOnReselect: true, request, receipt, priorPackets, packets: fresh, initialPty, resizedPty, exitConfirmed: true, fixtureExit: exit.code };
  const marker = `P04_PTY_SIGWINCH ${evidence.resizedPty.join(' ')}`;
  await ui.evaluate("if(!document.querySelector('.diagnostic-menu').open)document.querySelector('.diagnostic-menu summary').click()");
  await waitForResult(async () => {
    await ui.click('屏幕快照');
    return ui.evaluate(`document.querySelector('[aria-label="屏幕快照"]')?.textContent.split('\\n').some(line=>line.trim()===${JSON.stringify(marker)})`);
  }, 'fresh SIGWINCH marker absent from the actual terminal snapshot');
  const remaining = (await run('pwsh', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${servicePid} AND Name='ssh1-helper.exe'").Count`], options)).stdout.trim();
  assert.equal(remaining, '0');
  await writeFile('artifacts/P13-desktop-ssh1-initial-fit.json', JSON.stringify({
    ...evidence, visibleMarker: marker, helpersRemaining: Number(remaining),
  }, null, 2) + '\n');
  console.log('PASS SSH1 Desktop initial PTY fit, reselect without replay, and actual window resize');
}
