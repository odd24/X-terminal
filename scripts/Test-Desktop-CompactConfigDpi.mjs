import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop } from './lib/DesktopHarness.mjs';
import { active, activeText, desktopKeyboard } from './lib/DesktopKeyboard.mjs';

const manifest = process.argv[2] ?? 'artifacts/P12-compact-config-dpi-preview.json';
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

const prefix = 'shared-terminal-compact-config-dpi-中文-';
const root = await mkdtemp(path.join(tmpdir(), prefix));
const executable = path.resolve(preview.directory, 'shared-terminal-desktop.exe');
const artifact = 'P12-compact-config-dpi';
const dialog = 'dialog.app-dialog-wide[aria-label="连接配置"]';
const row = `${dialog} .profile-list button`;
const nameInput = `${dialog} [aria-label="配置名称"]`;
const hostInput = `${dialog} [aria-label="主机"]`;
const profile = {
  id: crypto.randomUUID(), folder_id: null, name: `紧凑窗口合成配置-${'longconfig'.repeat(11)}-end`,
  settings: { protocol: 'ssh2', host: `${'a'.repeat(48)}.${'b'.repeat(48)}.${'c'.repeat(48)}.invalid`,
    port: 22, username: 'synthetic', auth: 'password', encoding: 'utf8' },
};
const measurements = {};
const focusTrace = [];
const findings = [];
let ui;

try {
  ui = await launchDesktop(root, { executable });
  await ui.command('Page.bringToFront');
  assert.equal((await ui.invoke('service_status')).fixture, false);
  const physical = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-File', 'scripts/lib/Resize-TestWindow.ps1',
    '-TargetProcessId', String(ui.app.pid), '-ExpectedExecutable', executable, '-Width', '760', '-Height', '540'],
  { encoding: 'utf8', windowsHide: true }));
  measurements.physical = physical;
  assert.deepEqual([physical.pid, physical.dpi, physical.width, physical.height, physical.clientWidth, physical.clientHeight],
    [ui.app.pid, 96, 760, 540, 744, 501]);
  await ui.waitFor('innerWidth===744 && innerHeight===501 && devicePixelRatio===1');
  measurements.viewport = await ui.evaluate('({width:innerWidth,height:innerHeight,visualWidth:visualViewport.width,visualHeight:visualViewport.height,dpr:devicePixelRatio,theme:document.documentElement.dataset.theme})');
  assert.deepEqual(measurements.viewport, { width: 744, height: 501, visualWidth: 744, visualHeight: 501, dpr: 1, theme: 'dark' });

  const config = request => ui.invoke('config_request', { request });
  const page = () => config({ op: 'page', revision: null, offset: 0, folders: false });
  assert.deepEqual((await page()).profiles, []);

  const { key, enter, tabTo, recordFocus } = desktopKeyboard(ui, focusTrace);
  async function checkReturn(step, expected) {
    await ui.waitFor('!document.querySelector("dialog:modal")');
    await recordFocus(step);
    measurements[step] = focusTrace.at(-1);
    if (!await ui.evaluate(`(${activeText(expected)}) && document.activeElement.matches(':focus-visible')`)) {
      findings.push(`${step}: focus did not return to ${expected}`);
      await ui.screenshot(`${artifact}-return-failure.png`);
    }
  }

  // The empty session tree has its own visible, persistent configuration opener.
  await tabTo(activeText('会话导航'), '会话导航');
  await enter();
  await tabTo(activeText('新建连接配置'), '空会话树的配置入口');
  await enter();
  await ui.waitFor(activeText('关闭配置'));
  await ui.waitFor(`document.querySelector('[aria-label="配置状态"]')?.textContent==='配置已加载'`);
  await key('Tab', 'Tab', 9, { modifiers: 8 });
  assert.ok(await ui.evaluate(active('[aria-label="已保存副本"]')), 'Shift+Tab wraps within the shared dialog');
  await key('Tab', 'Tab', 9);
  assert.ok(await ui.evaluate(activeText('关闭配置')), 'Tab wraps back to the first control');
  await key('Escape', 'Escape', 27);
  await checkReturn('treeEscape', '新建连接配置');
  await tabTo(activeText('会话导航'), '收起会话导航', { backward: true });
  await enter();

  const saved = await config({ op: 'save_profile', profile, credential: { action: 'clear' } });
  assert.equal(saved.result, 'saved_profile');
  assert.equal(saved.profile.credential_ref, null);
  const before = await page();

  async function openFromTools() {
    await tabTo(activeText('更多工具'), '更多工具');
    await enter();
    await tabTo(activeText('连接配置'), '连接配置入口');
    await enter();
    await ui.waitFor(`!!document.querySelector(${JSON.stringify(row)})`);
  }
  await openFromTools();
  const panel = () => ui.evaluate(`(() => {const d=document.querySelector(${JSON.stringify(dialog)});
    return {box:d.getBoundingClientRect().toJSON(),clientWidth:d.clientWidth,clientHeight:d.clientHeight,
      scrollWidth:d.scrollWidth,scrollHeight:d.scrollHeight,scrollTop:d.scrollTop};})()`);
  measurements.dialog = await panel();
  const { box, clientWidth, clientHeight, scrollWidth, scrollHeight } = measurements.dialog;
  assert.ok(box.left >= 0 && box.right <= 744 && box.top >= 0 && box.bottom <= 501);
  assert.ok(scrollWidth <= clientWidth && scrollHeight > clientHeight);

  async function checkFocus(label) {
    const geometry = await ui.evaluate(`(() => {
      const node=document.activeElement, r=node.getBoundingClientRect(), style=getComputedStyle(node);
      const clip={left:0,top:0,right:innerWidth,bottom:innerHeight};
      for(let parent=node.parentElement;parent;parent=parent.parentElement){
        const p=parent.getBoundingClientRect(), css=getComputedStyle(parent);
        const x=p.left+parent.clientLeft,y=p.top+parent.clientTop;
        if(css.overflowX!=='visible'){clip.left=Math.max(clip.left,x);clip.right=Math.min(clip.right,x+parent.clientWidth);}
        if(css.overflowY!=='visible'){clip.top=Math.max(clip.top,y);clip.bottom=Math.min(clip.bottom,y+parent.clientHeight);}
      }
      return {rect:r.toJSON(),clip,visible:node.matches(':focus-visible'),outline:style.outlineStyle,
        width:parseFloat(style.outlineWidth),offset:parseFloat(style.outlineOffset),
        hit:[0.15,0.5,0.85].every(x=>[0.2,0.5,0.8].every(y=>node.contains(document.elementFromPoint(r.left+r.width*x,r.top+r.height*y))))};
    })()`);
    measurements[label] = geometry;
    const { rect, clip } = geometry;
    const fits = margin => rect.left - margin >= clip.left - 1 && rect.right + margin <= clip.right + 1
      && rect.top - margin >= clip.top - 1 && rect.bottom + margin <= clip.bottom + 1;
    if (!geometry.hit || !fits(0)) findings.push(`${label}: control clipped or obscured`);
    if (!geometry.visible || geometry.outline !== 'solid' || !fits(geometry.width + geometry.offset)) {
      findings.push(`${label}: keyboard focus outline is incomplete`);
    }
  }

  await tabTo(active(row), '长配置列表项');
  await checkFocus('profileRow');
  measurements.nameLines = await ui.evaluate(`(() => {const node=document.activeElement, range=document.createRange();
    range.selectNode(node.firstChild);
    return [...range.getClientRects()].map(rect=>rect.toJSON());})()`);
  assert.equal(await ui.evaluate('document.activeElement.firstChild.textContent'), profile.name);
  assert.ok(measurements.nameLines.length > 1 && measurements.nameLines.every(rect =>
    rect.left >= measurements.profileRow.rect.left && rect.right <= measurements.profileRow.rect.right));
  await ui.screenshot(`${artifact}-name.png`);
  await enter();
  await tabTo(active(nameInput), '配置名称');
  await checkFocus('nameInput');
  assert.equal(await ui.evaluate('document.activeElement.value'), profile.name);
  await tabTo(active(hostInput), '主机');
  await checkFocus('hostInput');
  assert.equal(await ui.evaluate('document.activeElement.value'), profile.settings.host);
  for (const label of ['保存配置', '复制配置', '删除配置']) {
    await tabTo(activeText(label), label);
    await checkFocus(label);
    assert.ok(await ui.evaluate('!document.activeElement.disabled'));
  }
  measurements.actions = await panel();
  assert.ok(measurements.actions.scrollTop > measurements.dialog.scrollTop);
  await ui.screenshot(`${artifact}-actions.png`);

  await key('Escape', 'Escape', 27);
  await checkReturn('toolsEscape', '更多工具');
  await openFromTools();
  await tabTo(activeText('关闭配置'), '关闭配置按钮');
  await enter();
  await checkReturn('toolsCloseButton', '更多工具');
  await checkFocus('toolsSummary');
  await ui.screenshot(`${artifact}-return.png`);
  const after = await page();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.profiles, before.profiles);
  assert.deepEqual(await ui.invoke('service_list'), []);
  await writeFile(`artifacts/${artifact}.json`, JSON.stringify({ result: findings.length ? 'FAIL' : 'PASS',
    preview: preview.directory, measurements, findings, focusTrace }, null, 2) + '\n');
  assert.deepEqual(findings, []);
} finally {
  await ui?.close();
  const resolved = await realpath(root);
  assert.equal(path.dirname(resolved), await realpath(tmpdir()));
  assert.ok(path.basename(resolved).startsWith(prefix));
  await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
console.log('PASS native compact wide configuration dialog: long values, keyboard actions and return focus');
