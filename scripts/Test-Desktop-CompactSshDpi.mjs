import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop } from './lib/DesktopHarness.mjs';
import { active, activeText, desktopKeyboard } from './lib/DesktopKeyboard.mjs';

const manifest = process.argv[2] ?? 'artifacts/P22-audit-grant-feedback-preview.json';
const preview = JSON.parse(await readFile(manifest, 'utf8'));
assert.equal(preview.result, 'PASS');
assert.equal(path.dirname(path.resolve(preview.directory)), path.resolve('artifacts'));
assert.deepEqual(preview.files.map(file => file.name).sort(),
  ['session-service.exe', 'shared-terminal-desktop.exe', 'terminal-mcp.exe']);
for (const file of preview.files) {
  const bytes = await readFile(path.join(preview.directory, file.name));
  assert.equal(bytes.length, file.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
}

const prefix = 'shared-terminal-compact-ssh-dpi-中文-';
const root = await mkdtemp(path.join(tmpdir(), prefix));
const executable = path.resolve(preview.directory, 'shared-terminal-desktop.exe');
const artifact = 'P12.1-compact-ssh-dpi';
const host = `t23-${'w'.repeat(288)}.invalid`;
const dialog = 'dialog[aria-label="连接服务器"]';
const hostField = `${dialog} [aria-label="SSH服务器"]`;
const submit = `${dialog} button[type="submit"]`;
const alert = `${dialog} [role="alert"]`;
const viewport = '({width:innerWidth,height:innerHeight,visualWidth:visualViewport.width,visualHeight:visualViewport.height,dpr:devicePixelRatio})';
const measurements = {};
const focusTrace = [];
let ui, evidence;

try {
  ui = await launchDesktop(root, { executable });
  await ui.command('Page.bringToFront');
  assert.equal((await ui.invoke('service_status')).fixture, false);
  const before = await ui.evaluate(viewport);
  const physical = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-File', 'scripts/lib/Resize-TestWindow.ps1',
    '-TargetProcessId', String(ui.app.pid), '-ExpectedExecutable', executable, '-Width', '760', '-Height', '540'],
  { encoding: 'utf8', windowsHide: true }));
  measurements.physical = physical;
  assert.equal(physical.pid, ui.app.pid);
  assert.equal(physical.width, physical.requestedWidth);
  assert.equal(physical.height, physical.requestedHeight);
  await ui.waitFor(`Math.abs(innerWidth * devicePixelRatio - ${physical.clientWidth}) <= devicePixelRatio
    && Math.abs(innerHeight * devicePixelRatio - ${physical.clientHeight}) <= devicePixelRatio`);
  const after = await ui.evaluate(viewport);
  measurements.before = before;
  measurements.viewport = after;
  assert.ok(after.width < before.width && after.height < before.height);
  assert.equal(after.dpr, physical.dpi / 96);
  assert.deepEqual([after.visualWidth, after.visualHeight], [after.width, after.height]);

  const { key, type, enter, tabTo } = desktopKeyboard(ui, focusTrace);

  // Intersect the visual viewport and every clipping ancestor, then hit-test
  // multiple interior points so an overlay cannot make a clipped control pass.
  async function measure(selector) {
    const actual = await ui.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      const r = node.getBoundingClientRect();
      const clip = { left:0, top:0, right:innerWidth, bottom:innerHeight };
      for (let parent=node.parentElement; parent; parent=parent.parentElement) {
        const style=getComputedStyle(parent), p=parent.getBoundingClientRect();
        const x=p.left+parent.clientLeft, y=p.top+parent.clientTop;
        if (style.overflowX !== 'visible') { clip.left=Math.max(clip.left,x); clip.right=Math.min(clip.right,x+parent.clientWidth); }
        if (style.overflowY !== 'visible') { clip.top=Math.max(clip.top,y); clip.bottom=Math.min(clip.bottom,y+parent.clientHeight); }
      }
      const hit = [0.15,0.5,0.85].every(x=>[0.2,0.5,0.8].every(y=>node.contains(document.elementFromPoint(r.left+r.width*x,r.top+r.height*y))));
      const style=getComputedStyle(node);
      return { rect:r.toJSON(),clip,hit, focus:node===document.activeElement&&node.matches(':focus-visible'),
        outline:style.outlineStyle,outlineWidth:parseFloat(style.outlineWidth),outlineOffset:parseFloat(style.outlineOffset) };
    })()`);
    return actual;
  }

  function assertReachable({ rect, clip, hit, focus, outline, outlineWidth, outlineOffset }, label, focused = false) {
    const inside = (margin) => rect.left - margin >= clip.left - 1 && rect.right + margin <= clip.right + 1
      && rect.top - margin >= clip.top - 1 && rect.bottom + margin <= clip.bottom + 1;
    assert.ok(rect.width > 0 && rect.height > 0 && hit && inside(0), `Clipped or obscured ${label}`);
    if (!focused) return;
    assert.ok(focus && outline === 'solid' && outlineWidth > 0, `No visible keyboard focus on ${label}`);
    assert.ok(inside(outlineWidth + Math.max(0, outlineOffset)), `Clipped focus outline on ${label}`);
  }

  const escape = () => key('Escape', 'Escape', 27);
  async function switchToLightTheme() {
    await tabTo(activeText('更多工具'), '更多工具');
    await enter();
    await tabTo(activeText('外观'), '外观');
    await enter();
    await tabTo(active('[aria-label="应用主题"]'), '应用主题');
    await key('Home', 'Home', 36);
    await key('ArrowDown', 'ArrowDown', 40);
    await ui.waitFor(`document.documentElement.dataset.theme==='light'`);
    await escape();
    await ui.waitFor('!document.querySelector("dialog:modal")');
  }

  const noPageOverflow = () => ui.evaluate('document.documentElement.scrollWidth <= innerWidth');
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await switchToLightTheme();
    await ui.waitFor(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
    const current = measurements[theme] = {};
    current.pageColor = await ui.evaluate('getComputedStyle(document.documentElement).backgroundColor');
    assert.ok(await noPageOverflow());
    await tabTo(activeText('连接服务器'), '工作区连接入口');
    current.workspace = await measure('nav .primary-action');
    assertReachable(current.workspace, 'workspace connection button', true);
    assertReachable(await measure('.terminal-empty h2'), 'empty workspace heading');
    await ui.screenshot(`${artifact}-${theme}-workspace.png`);

    await enter();
    await ui.waitFor(`!!document.querySelector(${JSON.stringify(`${hostField}:not([disabled])`)})`);
    await tabTo(active(hostField), '服务器地址');
    await ui.command('Input.insertText', { text: host });
    assert.equal(await ui.evaluate('document.activeElement.value'), host);
    await tabTo(active('[aria-label="SSH用户名"]'), '用户名');
    await type('synthetic');
    await tabTo(activeText('高级连接设置'), '高级连接设置');
    await enter();
    await tabTo(active('[aria-label="保存SSH连接"]'), '保存合成配置');
    await key(' ', 'Space', 32, { text: ' ' });
    await tabTo(active(submit), '本地校验前连接按钮');
    current.submit = await measure(submit);
    assert.deepEqual(await ui.invoke('service_list'), []);
    assertReachable(current.submit, 'SSH dialog connection button', true);

    // The resulting profile name exceeds the local 256-byte cap. The real
    // save rejection is shown before QuickConnect can dispatch SSH.
    await enter();
    await ui.waitFor(`document.querySelector(${JSON.stringify(alert)})?.textContent.includes('尚未发起SSH登录')`);
    current.error = await ui.evaluate(`document.querySelector(${JSON.stringify(alert)}).innerText`);
    assert.match(current.error, /保存连接\/凭据失败.*配置参数无效/s);
    assert.ok(!current.error.includes(host));
    current.alert = await measure(alert);
    assertReachable(current.alert, 'local error notice');
    assertReachable(await measure(`${alert} p`), 'local error text');
    assert.ok(await noPageOverflow());
    current.dialog = await ui.evaluate(`(() => {
      const node=document.querySelector(${JSON.stringify(dialog)});
      return {rect:node.getBoundingClientRect().toJSON(),clientWidth:node.clientWidth,clientHeight:node.clientHeight,
        scrollWidth:node.scrollWidth,scrollHeight:node.scrollHeight,scrollTop:node.scrollTop,
        color:getComputedStyle(node).backgroundColor};
    })()`);
    const { rect, clientWidth, clientHeight, scrollWidth, scrollHeight } = current.dialog;
    assert.ok(rect.left >= 0 && rect.top >= 0 && rect.right <= after.width && rect.bottom <= after.height);
    assert.ok(scrollWidth <= clientWidth && scrollHeight > clientHeight);
    await ui.screenshot(`${artifact}-${theme}-error.png`);

    await tabTo(active(hostField), '本地错误后的长地址');
    current.host = await measure(hostField);
    assertReachable(current.host, 'long address field', true);
    assert.equal(await ui.evaluate('document.activeElement.value'), host);
    await tabTo(active(submit), '本地错误后的连接按钮');
    current.submitAfter = await measure(submit);
    assertReachable(current.submitAfter, 'SSH dialog connection button after error', true);
    await ui.screenshot(`${artifact}-${theme}-button.png`);

    await tabTo(activeText('取消连接'), '弹窗末尾按钮');
    await key('Tab', 'Tab', 9);
    assert.ok(await ui.evaluate(activeText('收起连接窗口')));
    await key('Tab', 'Tab', 9, { modifiers: 8 });
    assert.ok(await ui.evaluate(activeText('取消连接')));
    if (theme === 'dark') await escape();
    else {
      await key('Tab', 'Tab', 9);
      await enter();
    }
    await ui.waitFor(`!document.querySelector('dialog:modal') && ${activeText('连接服务器')}`);
    assert.deepEqual(await ui.invoke('service_list'), []);
    const config = await ui.invoke('config_request', { request: { op: 'page', revision: null, offset: 0, folders: false } });
    assert.deepEqual(config.profiles, []);
  }
  assert.notEqual(measurements.dark.pageColor, measurements.light.pageColor);
  assert.notEqual(measurements.dark.dialog.color, measurements.light.dialog.color);
  assert.deepEqual(await ui.evaluate(viewport), after);
  evidence = { result: 'PASS', preview: preview.directory, measurements, focusTrace };
} catch (error) {
  await ui?.screenshot(`${artifact}-failure.png`).catch(() => {});
  await writeFile(`artifacts/${artifact}-failure.json`, JSON.stringify({ result: 'FAIL', preview: preview.directory,
    error: error.message, measurements, focusTrace }, null, 2) + '\n');
  console.error('Owned compact-window test root retained:', root);
  throw error;
} finally {
  await ui?.close();
}

const resolved = await realpath(root);
assert.equal(path.dirname(resolved), await realpath(tmpdir()));
assert.ok(path.basename(resolved).startsWith(prefix));
await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
await writeFile(`artifacts/${artifact}.json`, JSON.stringify(evidence, null, 2) + '\n');
console.log('PASS native compact window at current DPI: light/dark SSH dialog focus, local error and return to opener');
