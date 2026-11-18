import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { delay } from './DesktopHarness.mjs';
import { active, terminalInput } from './DesktopKeyboard.mjs';

const hostCheck = '[aria-label="已核对 SSH1 主机指纹"]';
const password = '[aria-label="SSH1 登录密码"]';
const reconnect = 'dialog[aria-label="显式重连 SSH1"]';
const packets = trial => [...trial.wire.matchAll(/^P13 SSH1_PASSWORD_(ACCEPTED|REJECTED)\r?$/gm)].map(match => match[1]);
const button = text => `[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)})`;

async function waitFor(get, description) {
  for (let i = 0; i < 100; i++) {
    const value = await get();
    if (value) return value;
    await delay(35);
  }
  throw new Error(description);
}

export async function verifyDesktopSsh1Vault({ ui, keyboard, saved, positive, listen, openSaved, withFixturePassword,
  preview, replacementFingerprint, servicePid }) {
  const ssh = request => ui.invoke('ssh_request', { request });
  const status = connection => ssh({ op: 'status', connection });
  const configure = (profile, credential) => ui.invoke('config_request', { request: { op: 'save_profile', profile, credential } });
  const select = selector => ui.evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  const approval = (connection, challenge_id) => ({ op: 'authenticate', connection, challenge_id, use_saved: true, password: null });
  const rejected = request => ui.evaluate(`window.__TAURI_INTERNALS__.invoke('ssh_request',${JSON.stringify({ request })}).then(()=>'accepted',String)`);
  const focused = connection => active(`.terminal-pane[data-active="true"][data-rendered-id="${connection.connection_id}"][data-rendered-generation="${connection.generation}"] ${terminalInput}`);
  const ended = connection => waitFor(async () => ['FAILED', 'DISCONNECTED'].includes((await status(connection)).connection.state), 'SSH1 connection must end');
  const refresh = () => ui.click('刷新会话树');

  async function approveHost(connection, trial, changed = false) {
    const before = (await status(connection)).challenge;
    assert.equal(before.kind, 'host_key');
    assert.equal(before.review.status, changed ? 'changed' : 'unknown');
    if (changed) assert.equal(before.review.candidate.fingerprint, replacementFingerprint);
    assert.equal(await ui.evaluate(`!!${button('使用已保存密码')}`), false);
    assert.equal(await ui.evaluate(`!!document.querySelector(${JSON.stringify(password)})`), false);
    assert.equal(await rejected(approval(connection, before.id)), 'InvalidState');
    assert.deepEqual(packets(trial), []);
    await select(hostCheck);
    await ui.click('信任 SSH1 主机并继续');
    await ui.waitFor(`${active(password)} && !document.activeElement.disabled`);
    const after = (await status(connection)).challenge;
    assert.equal(after.kind, 'credentials');
    assert.equal(after.auth, 'password');
    assert.equal(await ui.evaluate('document.activeElement.value'), '');
    assert.deepEqual(packets(trial), []);
    return after;
  }

  async function useSaved(connection, trial, challenge) {
    assert.equal(challenge.stored_available, true);
    await ui.waitFor(`!!${button('使用已保存密码')} && !${button('使用已保存密码')}.disabled`);
    await ui.click('使用已保存密码');
    await ui.waitFor(focused(connection));
    await waitFor(() => packets(trial).length > 0, 'remote did not observe the password');
    assert.deepEqual(packets(trial), ['ACCEPTED']);
    assert.equal(await rejected(approval(connection, challenge.id)), 'InvalidState');
  }

  const original = await openSaved(saved, positive);
  const originalTrial = positive.trials[0];
  const first = await approveHost(original, originalTrial);
  await useSaved(original, originalTrial, first);
  originalTrial.socket.destroy();
  await ended(original);
  await ui.waitFor(`!!${button('显式重连 SSH1')} && !${button('显式重连 SSH1')}.disabled`);
  await ui.click('显式重连 SSH1');
  await ui.waitFor(`!!document.querySelector(${JSON.stringify(reconnect)})`);
  assert.equal(positive.accepted, 1);
  await select('[aria-label="本次允许使用 SSH1"]');
  await ui.click('重连此 SSH1 会话');
  await ui.waitFor(`!!document.querySelector(${JSON.stringify(hostCheck)})`);
  assert.equal(positive.accepted, 2);
  const next = { connection_id: original.connection_id, generation: original.generation + 1 };
  const nextTrial = positive.trials[1];
  const second = await approveHost(next, nextTrial, true);
  assert.notEqual(first.id, second.id);
  assert.equal(await rejected(approval(next, first.id)), 'InvalidState');
  await useSaved(next, nextTrial, second);
  await select(`[aria-label="关闭标签 ${next.connection_id}"]`);
  await ended(next);

  async function prepareCase(name, kind) {
    const peer = await listen();
    const profile = { id: crypto.randomUUID(), folder_id: null, name, settings: { ...saved.settings, port: peer.port } };
    if (kind === undefined) {
      assert.equal((await configure(profile, { action: 'clear' })).profile.credential_ref, null);
    } else {
      await withFixturePassword(async text => {
        const reply = await configure(profile, { action: 'replace', value: { password: text, private_key: null, passphrase: null } });
        assert.equal(reply.result, 'saved_profile');
        assert.ok(reply.profile.credential_ref);
      }, kind);
    }
    await refresh();
    const connection = await openSaved(profile, peer);
    const trial = peer.trials[0];
    return { profile, connection, trial, challenge: await approveHost(connection, trial) };
  }

  const missing = await prepareCase('SSH1 无密码引用');
  assert.equal(missing.challenge.stored_available, false);
  assert.equal(await ui.evaluate(`!!${button('使用已保存密码')}`), false);
  assert.equal(await rejected(approval(missing.connection, missing.challenge.id)), 'InvalidState');
  assert.deepEqual(packets(missing.trial), []);
  await withFixturePassword(text => keyboard.type(text));
  await keyboard.enter();
  await ui.waitFor(focused(missing.connection));
  await waitFor(() => packets(missing.trial).length > 0, 'temporary password not observed');
  assert.deepEqual(packets(missing.trial), ['ACCEPTED']);
  await select(`[aria-label="关闭标签 ${missing.connection.connection_id}"]`);
  await ended(missing.connection);

  const stale = await prepareCase('SSH1 配置变化夹具', 'GOOD');
  assert.equal(stale.challenge.stored_available, true);
  const changed = await configure({ ...stale.profile, name: 'SSH1 已编辑配置' }, { action: 'keep' });
  assert.ok(changed.profile.credential_ref);
  await ui.click('使用已保存密码');
  await ui.waitFor(`[...document.querySelectorAll('[role="alert"]')].some(e=>e.textContent.includes('原保存配置已变化，本次未提交密码'))`);
  assert.equal((await status(stale.connection)).failure, 'CREDENTIAL_CONFIGURATION_CHANGED');
  assert.deepEqual(packets(stale.trial), []);
  await ui.click('关闭 SSH1 连接窗口');

  const bad = await prepareCase('SSH1 密码拒绝夹具', 'BAD');
  await ui.click('使用已保存密码');
  await ui.waitFor(`[...document.querySelectorAll('[role="alert"]')].some(e=>e.textContent.includes('服务器拒绝本次密码'))`);
  assert.equal((await status(bad.connection)).failure, 'AUTHENTICATION_REJECTED');
  await waitFor(() => packets(bad.trial).length > 0, 'negative fixture did not decode the SSH1 password');
  assert.deepEqual(packets(bad.trial), ['REJECTED']);
  assert.equal(await rejected(approval(bad.connection, bad.challenge.id)), 'InvalidState');
  await ui.click('关闭 SSH1 连接窗口');

  const trials = [originalTrial, nextTrial, missing.trial, stale.trial, bad.trial];
  const exits = await Promise.all(trials.map(trial => trial.done));
  assert.ok(exits.every(exit => exit.signal === null && [0, 124].includes(exit.code)));
  assert.deepEqual(trials.map(packets), [['ACCEPTED'], ['ACCEPTED'], ['ACCEPTED'], [], ['REJECTED']]);
  const remaining = execFileSync('pwsh', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${servicePid} AND Name='ssh1-helper.exe'").Count`],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
  assert.equal(remaining, '0');
  await writeFile('artifacts/P13-desktop-ssh1-vault.json', JSON.stringify({
    result: 'PASS', preview, original, next, windowsProtectedReference: true, changedHostReapproved: true,
    hostApprovalBeforePassword: true, explicitSavedUseOnBothGenerations: true, missingReferenceRejected: true,
    staleProfileRejected: true, fixturePasswords: trials.map(packets), exits, helperProcessesRemaining: 0,
  }, null, 2) + '\n');
  console.log('PASS Desktop SSH1 Vault, original-profile guard, host ordering and one authentication attempt');
}
