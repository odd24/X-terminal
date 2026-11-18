import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { requestId } from '../../apps/desktop/src/request-id.ts';
import { delay } from './DesktopHarness.mjs';
import { active, terminalInput } from './DesktopKeyboard.mjs';

const run = promisify(execFile);
const options = { windowsHide: true, encoding: 'utf8', timeout: 5000 };
const modal = 'dialog[aria-label="显式重连 SSH1"]';
const password = '[aria-label="SSH1 登录密码"]';
const approval = '[aria-label="本次允许使用 SSH1"]';
const hostApproval = '[aria-label="已核对 SSH1 主机指纹"]';
const ready = ref => active(`.terminal-pane[data-active="true"][data-rendered-id="${ref.connection_id}"][data-rendered-generation="${ref.generation}"] ${terminalInput}`);

async function waitFor(get, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await get();
    if (result) return result;
    await delay(30);
  }
  throw new Error(label);
}

export async function verifyDesktopSsh1Reconnect({ ui, keyboard, previous, saved, peer, wsl, firstChallenge,
  fingerprint, replacementFingerprint, typePassword, preview, servicePid }) {
  const ssh = request => ui.invoke('ssh_request', { request });
  const rejected = request => ui.evaluate(`window.__TAURI_INTERNALS__.invoke('ssh_request',${JSON.stringify({ request })}).then(()=>'accepted',String)`);
  const click = selector => ui.evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  const state = async connection => (await ssh({ op: 'status', connection })).connection.state;
  const bytes = async trial => {
    const { stdout } = await run('wsl.exe', [...wsl, '/usr/bin/od', '-An', '-t', 'u1', `p13-input-${trial}.bin`], options);
    return stdout.trim() ? stdout.trim().split(/\s+/).map(Number) : [];
  };
  const waitReady = connection => waitFor(async () => {
    const page = await ui.invoke('service_read', { connection, cursor: 1 });
    assert.deepEqual(page.connection, connection);
    return Buffer.from(page.events.flatMap(event => event.bytes)).includes('P13_RECONNECT_READY\r\n');
  }, 'remote raw PTY must signal readiness');
  const insert = text => ui.command('Input.insertText', { text });

  assert.equal(firstChallenge.kind, 'credentials');
  assert.equal(firstChallenge.stored_available, false);
  assert.notEqual(fingerprint, replacementFingerprint);
  await waitReady(previous);
  const config = await ui.invoke('config_request', { request: { op: 'page', revision: null, folders: false, offset: 0 } });
  const profile = { profile_id: saved.id, revision: config.revision };
  const request = { op: 'reconnect_fixed', connection: previous, profile, request_id: requestId(), cols: 80, rows: 24 };
  assert.equal(await rejected(request), 'InvalidState');
  assert.equal(peer.accepted, 1);

  const held = await ui.interceptIpc({ command: 'ssh_request', op: 'write_text', connectionId: previous.connection_id, mode: 'hold' });
  try {
    await insert('A');
    await waitFor(async () => await held.count() === 1 && (await bytes('first')).length === 1, 'first byte and held reply must reach their targets');
    assert.deepEqual(await bytes('first'), [65]);
    await insert('B');
    await delay(170);
    assert.equal(await held.count(), 1, 'queued old key must remain behind the original write');
    assert.deepEqual(await bytes('first'), [65]);
    peer.trials[0].socket.destroy();
    await waitFor(async () => ['FAILED', 'DISCONNECTED'].includes(await state(previous)), 'original transport must end');
    await ui.waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent==='显式重连 SSH1'&&!b.disabled)");
  } finally { await held.restore(); }
  assert.equal(peer.accepted, 1, 'disconnect must never start a replacement');
  assert.equal(await rejected({ ...request, request_id: requestId(), profile: { ...profile, revision: requestId() } }), 'InvalidArgument');
  assert.equal(await rejected({ ...request, request_id: requestId(), profile: { ...profile, profile_id: requestId() } }), 'InvalidArgument');
  assert.equal(await rejected({ op: 'reconnect', connection: previous, request_id: requestId(), cols: 80, rows: 24 }), 'Unsupported');
  assert.equal(peer.accepted, 1, 'configuration or protocol mismatch must not dial');

  await ui.click('显式重连 SSH1');
  await ui.waitFor(`!!document.querySelector(${JSON.stringify(modal)})`);
  const displayedScope = await ui.evaluate("document.querySelector('[aria-label=\"SSH1 重连范围\"]').textContent");
  assert.ok(displayedScope.includes(previous.connection_id) && displayedScope.includes(`旧代次 ${previous.generation}`)
    && displayedScope.includes(profile.revision));
  assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(approval)}).checked`), false);
  assert.equal(peer.accepted, 1);
  await click(approval);
  await ui.evaluate(`(() => {
    const original=window.fetch, requests=[];
    window.__ssh1ReconnectTrace={original,requests};
    window.fetch=function(input,init){
      if(new URL(String(input)).pathname==='/ssh_request'){
        const request=JSON.parse(init.body)?.request;
        if(request?.op==='reconnect_fixed'||request?.op==='reconnect_fixed_status')requests.push(request);
      }
      return original.call(this,input,init);
    };
  })()`);
  const lost = await ui.interceptIpc({ command: 'ssh_request', op: 'reconnect_fixed', mode: 'error' });
  let calls;
  try {
    await ui.click('重连此 SSH1 会话');
    await ui.waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent==='仅查询原 SSH1 编号')");
    assert.equal(await lost.count(), 1);
    await ui.click('仅查询原 SSH1 编号');
    await ui.waitFor(`!!document.querySelector(${JSON.stringify(hostApproval)})`);
    calls = await ui.evaluate('window.__ssh1ReconnectTrace.requests');
    assert.equal(await lost.count(), 1, 'recovery must not replay the mutation');
  } finally {
    try { await lost.restore(); }
    finally { await ui.evaluate('window.fetch=window.__ssh1ReconnectTrace.original;delete window.__ssh1ReconnectTrace'); }
  }
  assert.deepEqual(calls.map(call => call.op), ['reconnect_fixed', 'reconnect_fixed_status']);
  const [attempt, query] = calls;
  assert.deepEqual(attempt.connection, previous);
  assert.deepEqual(attempt.profile, profile);
  assert.deepEqual(query, { op: 'reconnect_fixed_status', connection: previous, profile, request_id: attempt.request_id });
  const receipt = await ssh(query);
  assert.equal(receipt.result, 'reconnect_fixed_receipt');
  assert.deepEqual(receipt.previous, previous);
  assert.deepEqual(receipt.profile, profile);
  assert.equal(receipt.request_id, attempt.request_id);
  const next = { connection_id: previous.connection_id, generation: previous.generation + 1 };
  assert.deepEqual(receipt.connection, { ...next, protocol: 'SSH1', state: 'CONNECTING' });
  assert.equal(await rejected({ op: 'reconnect_status', connection: previous, request_id: query.request_id }), 'PermissionDenied');
  assert.equal(await rejected({ op: 'connect_status', ...profile, request_id: query.request_id }), 'PermissionDenied');
  assert.equal(await rejected({ ...query, profile: { ...profile, revision: requestId() } }), 'InvalidArgument');
  assert.equal(await rejected({ op: 'write_text', connection: previous, request_id: requestId(), text: 'B' }), 'StaleGeneration');
  assert.equal(peer.accepted, 2);
  const host = (await ssh({ op: 'status', connection: next })).challenge;
  assert.equal(host.kind, 'host_key');
  assert.equal(host.review.status, 'changed');
  assert.equal(host.review.candidate.fingerprint, replacementFingerprint);
  assert.equal(await ui.evaluate(`document.querySelector(${JSON.stringify(hostApproval)}).checked`), false);
  await click(hostApproval);
  await ui.click('信任 SSH1 主机并继续');
  await ui.waitFor(`${active(password)} && !document.activeElement.disabled`);
  const challenge = (await ssh({ op: 'status', connection: next })).challenge;
  assert.equal(challenge.kind, 'credentials');
  assert.equal(challenge.auth, 'password');
  assert.equal(challenge.stored_available, false);
  assert.notEqual(challenge.id, firstChallenge.id);
  assert.equal(await ui.evaluate('document.activeElement.value'), '');
  assert.equal(await rejected({ op: 'authenticate', connection: next, challenge_id: firstChallenge.id,
    use_saved: false, password: 'synthetic-unused' }), 'InvalidState');
  await typePassword();
  await keyboard.enter();
  await ui.waitFor(`!document.querySelector(${JSON.stringify(modal)}) && ${ready(next)}`);
  await waitReady(next);
  await delay(200);
  assert.deepEqual(await bytes('first'), [65]);
  assert.deepEqual(await bytes('second'), []);
  await insert('Z');
  await waitFor(async () => (await bytes('second')).length > 0, 'one new keyboard byte must reach the new PTY');
  await delay(200);
  assert.deepEqual(await bytes('second'), [90]);
  const tab = `[role="tab"][data-connection-id="${next.connection_id}"]`;
  await click(`[aria-label="关闭标签 ${next.connection_id}"]`);
  await ui.waitFor(`!document.querySelector(${JSON.stringify(tab)})`);
  await waitFor(async () => ['FAILED', 'DISCONNECTED'].includes(await state(next)), 'new connection must end');
  const exits = await Promise.all(peer.trials.map(trial => trial.done));
  assert.ok(exits.every(exit => exit.signal === null && [0, 124].includes(exit.code)));
  const remaining = (await run('pwsh', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${servicePid} AND Name='ssh1-helper.exe'").Count`], options)).stdout.trim();
  assert.equal(remaining, '0');
  await writeFile('artifacts/P13-desktop-ssh1-reconnect.json', JSON.stringify({
    result: 'PASS', preview, previous, next, attempt, query, receipt, changedHostReapproved: true, newPasswordChallenge: true,
    activeRejected: true, staleRevisionRejected: true, oldChallengeRejected: true, staleInputRejected: true,
    peerConnections: peer.accepted, oldPeerBytes: [65], newPeerBytes: [90], exits,
  }, null, 2) + '\n');
  console.log('PASS explicit Desktop SSH1 reconnect, original receipt recovery and exact new PTY input');
}
