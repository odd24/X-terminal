import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { delay } from './DesktopHarness.mjs';
import { active, activeText, desktopKeyboard } from './DesktopKeyboard.mjs';

const dialog = 'dialog[aria-label="连接 SSH1 保存配置"]';
const consent = '[aria-label="本次允许使用 SSH1"]';
const hostConsent = '[aria-label="已核对 SSH1 主机指纹"]';
const password = '[aria-label="SSH1 登录密码"]';
const opener = '连接选中配置';
const trust = '信任 SSH1 主机并继续';
const reject = '拒绝 SSH1 主机';
const query = selector => `document.querySelector(${JSON.stringify(selector)})`;

export async function verifyDesktopSsh1Keyboard({ ui, saved, peer, executable, fingerprint, servicePid }) {
  const artifact = `P13-ssh1-compact-keyboard-${randomUUID()}`;
  const evidence = { result: 'FAIL', executable, servicePid, focusTrace: [], snapshots: {}, failures: [] };
  const { key, enter, tabTo, recordFocus } = desktopKeyboard(ui, evidence.focusTrace);
  const space = () => key(' ', 'Space', 32, { text: ' ' });
  const inDialog = text => `Array.from(${query(dialog)}.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)})`;
  const check = (condition, failure) => { if (!condition) evidence.failures.push(failure); };

  async function snapshot(step) {
    await ui.evaluate('new Promise(resolve=>requestAnimationFrame(()=>resolve()))');
    const view = await ui.evaluate(`(() => {
      const dialog = ${query(dialog)}, item = document.activeElement, bounds = item.getBoundingClientRect();
      const clip = {left:0, top:0, right:innerWidth, bottom:innerHeight};
      for (let parent=item.parentElement; parent; parent=parent.parentElement) {
        const style=getComputedStyle(parent), r=parent.getBoundingClientRect();
        const x=r.left+parent.clientLeft, y=r.top+parent.clientTop;
        if (style.overflowX !== 'visible') { clip.left=Math.max(clip.left,x); clip.right=Math.min(clip.right,x+parent.clientWidth); }
        if (style.overflowY !== 'visible') { clip.top=Math.max(clip.top,y); clip.bottom=Math.min(clip.bottom,y+parent.clientHeight); }
      }
      const style = getComputedStyle(item);
      const margin = (parseFloat(style.outlineWidth) || 0) + Math.max(0, parseFloat(style.outlineOffset) || 0);
      const outlineFits = bounds.left-margin >= clip.left-1 && bounds.top-margin >= clip.top-1
        && bounds.right+margin <= clip.right+1 && bounds.bottom+margin <= clip.bottom+1;
      const hit = bounds.width > 0 && bounds.height > 0 && item.contains(document.elementFromPoint(
        bounds.left+bounds.width/2, bounds.top+bounds.height/2));
      const sections = dialog ? [dialog, ...dialog.querySelectorAll('*')].filter(node =>
        node.clientHeight && node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) : [];
      const summary = item.closest('.profile-summary');
      return { tag:item.tagName, label:item.getAttribute('aria-label') ?? (item.matches('button') ? item.textContent.trim() : null),
        focusVisible:item.matches(':focus-visible'), hit, outlineFits, outline:style.outlineStyle, outlineWidth:style.outlineWidth,
        bounds:bounds.toJSON(), clip, modal:dialog?.matches(':modal') ?? false,
        scroll:sections.map(node=>({tag:node.tagName, top:node.scrollTop, height:node.clientHeight, extent:node.scrollHeight})),
        summaryScroll:summary ? { top:summary.scrollTop, height:summary.clientHeight, extent:summary.scrollHeight } : null,
        pageScroll:[scrollX, scrollY],
        passwordPresent:!!${query(password)} };
    })()`);
    evidence.snapshots[step] = view;
    assert.equal(view.passwordPresent, false);
    return view;
  }

  function checkFocus(view, step) {
    check(view.hit && view.focusVisible && view.outlineFits && view.outline !== 'none'
      && parseFloat(view.outlineWidth) > 0, `${step} has no fully visible keyboard focus outline`);
  }

  try {
    const physical = evidence.physical = JSON.parse(execFileSync('pwsh', [
      '-NoProfile', '-File', 'scripts/lib/Resize-TestWindow.ps1', '-TargetProcessId', String(ui.app.pid),
      '-ExpectedExecutable', executable, '-Width', '760', '-Height', '540', '-PhysicalSize',
    ], { encoding: 'utf8', windowsHide: true, timeout: 6000 }));
    assert.deepEqual([physical.pid, physical.width, physical.height], [ui.app.pid, 760, 540]);
    await ui.waitFor(`Math.abs(innerWidth*devicePixelRatio-${physical.clientWidth})<=devicePixelRatio
      && Math.abs(innerHeight*devicePixelRatio-${physical.clientHeight})<=devicePixelRatio`);
    evidence.viewport = await ui.evaluate('({ width:innerWidth, height:innerHeight, dpr:devicePixelRatio })');
    assert.equal(evidence.viewport.dpr, physical.dpi / 96);

    const row = `.session-tree-list button[data-profile-id="${saved.id}"]`;
    if (!await ui.evaluate(`!!${query(row)}?.getClientRects().length`)) {
      await tabTo(activeText('会话导航'), '会话导航', { backward: true });
      if (await ui.evaluate(`document.activeElement.getAttribute('aria-expanded')==='false'`)) await enter();
      await tabTo(activeText('刷新会话树'), '刷新会话树');
      await enter();
    }
    await ui.waitFor(`!!${query(row)}?.getClientRects().length`);
    await tabTo(active(row), '已保存 SSH1 项');
    await enter();
    assert.equal(await ui.evaluate(`${query(row)}.getAttribute('aria-pressed')`), 'true');
    await ui.waitFor(`[...document.querySelectorAll('.profile-summary button')].some(button=>
      button.textContent===${JSON.stringify(opener)}&&!button.disabled)`);
    await tabTo(activeText(opener), opener);
    checkFocus(await snapshot('opener'), 'saved profile opener');
    await enter();
    await ui.waitFor(`!!${query(dialog)}?.matches(':modal')`);
    const warning = await snapshot('warning');
    checkFocus(warning, 'initial warning');
    assert.match(await ui.evaluate(`${query(dialog + ' .config-notice')}.innerText`), /可能不安全的旧协议/);
    assert.equal(await ui.evaluate(`${query(consent)}.checked`), false);
    assert.equal(await ui.evaluate(`${inDialog('连接此 SSH1 配置')}.disabled`), true);
    assert.equal(peer.accepted, 0);
    await tabTo(active(consent), '本次明确选择 SSH1');
    await space();
    await tabTo(activeText('连接此 SSH1 配置'), '连接此 SSH1 配置');
    await enter();

    await ui.waitFor(`!!${query(hostConsent)}`);
    assert.equal(peer.accepted, 1);
    const [connection] = await ui.invoke('service_list');
    assert.equal(connection.protocol, 'SSH1');
    const ref = { connection_id: connection.connection_id, generation: connection.generation };
    const status = () => ui.invoke('ssh_request', { request: { op: 'status', connection: ref } });
    const pending = await status();
    assert.equal(pending.profile_id, saved.id);
    assert.equal(pending.challenge?.kind, 'host_key');
    assert.equal(await ui.evaluate(`${query(dialog + ' .fingerprint')}.textContent`), fingerprint);
    assert.equal(await ui.evaluate(`${query(hostConsent)}.checked`), false);
    assert.equal(await ui.evaluate(`${inDialog(trust)}.disabled`), true);
    const initialHost = await snapshot('hostInitial');
    check(initialHost.modal && initialHost.label === '已核对 SSH1 主机指纹',
      'host challenge did not restore focus to the fingerprint checkbox');
    checkFocus(initialHost, 'initial host fingerprint checkbox');
    await ui.screenshot(`${artifact}-host.png`);
    await tabTo(active(hostConsent), '核对 SSH1 主机指纹');
    checkFocus(await snapshot('hostCheckbox'), 'host fingerprint checkbox');
    await space();
    await tabTo(activeText(trust), trust);
    checkFocus(await snapshot('hostTrust'), 'host trust button');
    await ui.screenshot(`${artifact}-trust.png`);
    await tabTo(activeText(reject), reject);
    checkFocus(await snapshot('hostReject'), 'host reject button');
    await enter();
    await ui.waitFor(`${query(dialog + ' [role="alert"]')}?.textContent.includes('本次未提交密码')`);
    const refusal = await status();
    assert.equal(refusal.failure, 'HOST_KEY_REJECTED');
    assert.ok(!refusal.challenge);
    evidence.hostFailure = refusal.failure;
    await snapshot('refusal');

    await key('Escape', 'Escape', 27);
    await ui.waitFor(`!${query(dialog)}`);
    await recordFocus('拒绝后 Escape 返回');
    const returned = await snapshot('return');
    check(returned.label === opener, 'Escape did not restore focus to the saved profile opener');
    checkFocus(returned, 'return to opener');
    assert.deepEqual(returned.pageScroll, evidence.snapshots.opener.pageScroll);
    await ui.screenshot(`${artifact}-return.png`);

    const fixture = evidence.fixtureExit = await peer.trials[0].done;
    assert.equal(fixture.signal, null);
    assert.ok([0, 124].includes(fixture.code));
    evidence.helpers = Number(execFileSync('pwsh', ['-NoProfile', '-Command',
      `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${servicePid} AND Name='ssh1-helper.exe'").Count`],
    { windowsHide: true, encoding: 'utf8', timeout: 5000 }).trim());
    assert.equal(evidence.helpers, 0);
    await tabTo(activeText('更多工具'), '更多工具', { backward: true });
    await enter();
    await tabTo(activeText('退出桌面'), '退出桌面');
    await enter();
    for (let attempt = 0; attempt < 100 && ui.app.exitCode === null && ui.app.signalCode === null; attempt++) await delay(50);
    evidence.desktopExit = { code: ui.app.exitCode, signal: ui.app.signalCode };
    assert.deepEqual(evidence.desktopExit, { code: 0, signal: null });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(servicePid, 0); }
      catch (error) {
        if (error.code !== 'ESRCH') throw error;
        break;
      }
      await delay(50);
    }
    assert.throws(() => process.kill(servicePid, 0), { code: 'ESRCH' });
    evidence.serviceExited = true;
    assert.deepEqual(evidence.failures, []);
    evidence.result = 'PASS';
  } catch (error) {
    evidence.error = error.message;
    if (ui.app.exitCode === null) await ui.screenshot(`${artifact}-failure.png`).catch(() => {});
    throw error;
  } finally {
    await writeFile(`artifacts/${artifact}.json`, JSON.stringify(evidence, null, 2) + '\n');
    console.log(`${evidence.result} ${artifact}.json`);
  }
}
