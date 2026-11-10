import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop } from './lib/DesktopHarness.mjs';
import { active, activeText, desktopKeyboard } from './lib/DesktopKeyboard.mjs';

const preview = JSON.parse(await readFile('artifacts/P12-standard-workspace-dpi-preview.json', 'utf8'));
assert.equal(preview.result, 'PASS');
assert.equal(path.resolve(preview.directory), path.resolve('artifacts/shared-terminal-preview-8b060b6f-d009-4e87-aedd-d662690c6ce1'));
assert.deepEqual(preview.files.map(file => file.name).sort(),
  ['session-service.exe', 'shared-terminal-desktop.exe', 'terminal-mcp.exe']);
for (const file of preview.files) {
  const bytes = await readFile(path.join(preview.directory, file.name));
  assert.equal(bytes.length, file.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
}

const prefix = 'shared-terminal-workspace-platform-fonts-中文-';
const artifact = 'P12-workspace-platform-fonts';
const root = await mkdtemp(path.join(tmpdir(), prefix));
const executable = path.join(preview.directory, 'shared-terminal-desktop.exe');
const sample = ['中文字体样例', 'AsciiSample', '0123456789'];
const name = sample.join(' ');
const focusTrace = [];
let ui, evidence;

try {
  ui = await launchDesktop(root, { executable });
  await ui.command('Page.bringToFront');
  assert.equal((await ui.invoke('service_status')).fixture, false);
  const physical = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-File', 'scripts/lib/Resize-TestWindow.ps1',
    '-TargetProcessId', String(ui.app.pid), '-ExpectedExecutable', executable, '-Width', '760', '-Height', '540', '-MeasureOnly'],
  { encoding: 'utf8', windowsHide: true }));
  const viewport = await ui.evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,theme:document.documentElement.dataset.theme})');
  assert.equal(physical.pid, ui.app.pid);
  assert.equal(physical.dpi / 96, viewport.dpr);

  const config = request => ui.invoke('config_request', { request });
  const page = () => config({ op: 'page', revision: null, offset: 0, folders: false });
  assert.deepEqual((await page()).profiles, []);
  const profile = { id: crypto.randomUUID(), name, folder_id: null, settings: {
    protocol: 'ssh2', host: 'platform-fonts.invalid', port: 22, username: 'synthetic', auth: 'password', encoding: 'utf8',
  } };
  const saved = await config({ op: 'save_profile', profile, credential: { action: 'clear' } });
  assert.equal(saved.result, 'saved_profile');
  assert.equal(saved.profile.credential_ref, null);
  const before = await page();
  const { enter, tabTo } = desktopKeyboard(ui, focusTrace);
  await tabTo(activeText('会话导航'), '打开实际会话导航');
  await enter();
  await tabTo(`(${activeText('刷新会话树')}) && !document.activeElement.disabled`, '刷新已预置配置');
  await enter();
  const selector = `.session-tree-list button[data-profile-id="${profile.id}"]`;
  await ui.waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
  await tabTo(active(selector), '聚焦实际中英数字配置行');
  const layout = await ui.evaluate(`(async () => {
    await document.fonts.ready;
    const row=document.activeElement, css=getComputedStyle(row), box=row.getBoundingClientRect();
    const tree=row.closest('.tree-scroll'), treeBox=tree.getBoundingClientRect();
    const clip={left:treeBox.left+tree.clientLeft,top:treeBox.top+tree.clientTop,
      right:treeBox.left+tree.clientLeft+tree.clientWidth,bottom:treeBox.top+tree.clientTop+tree.clientHeight};
    const tokens=${JSON.stringify(sample)}, rectangles=[];
    let index=0;
    for(const token of tokens){
      const range=document.createRange(); range.setStart(row.firstChild,index); range.setEnd(row.firstChild,index+token.length);
      rectangles.push([...range.getClientRects()].map(r=>r.toJSON())); index+=token.length+1;
    }
    const hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);
    return {text:row.textContent,computedFamily:css.fontFamily,
      uiToken:getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim(),rectangles,clip,box:box.toJSON(),
      focused:row.matches(':focus-visible'),hit:row.contains(hit),outline:css.outlineStyle,
      margin:parseFloat(css.outlineWidth)+parseFloat(css.outlineOffset)};
  })()`);
  assert.equal(layout.text, name);
  assert.equal(layout.computedFamily, layout.uiToken);
  const { box, clip, margin } = layout;
  assert.ok(layout.focused && layout.hit && layout.outline === 'solid' && margin > 0);
  assert.ok(box.left - margin >= clip.left - 1 && box.right + margin <= clip.right + 1
    && box.top - margin >= clip.top - 1 && box.bottom + margin <= clip.bottom + 1);
  assert.ok(layout.rectangles.every(rectangles => rectangles.length > 0 && rectangles.every(rect => rect.width > 0
    && rect.left >= box.left && rect.right <= box.right && rect.top >= box.top && rect.bottom <= box.bottom)));

  await ui.command('DOM.enable');
  const { root: document } = await ui.command('DOM.getDocument', { depth: 0 });
  const { nodeId } = await ui.command('DOM.querySelector', { nodeId: document.nodeId, selector });
  assert.ok(nodeId > 0);
  let fonts, capability;
  try {
    await ui.command('CSS.enable');
    ({ fonts } = await ui.command('CSS.getPlatformFontsForNode', { nodeId }));
  } catch (error) { capability = error.message; }
  if (!fonts?.length) capability ??= 'No platform font usage returned for the rendered row';
  if (!capability) {
    assert.ok(fonts.every(font => font.familyName && Number.isInteger(font.glyphCount) && font.glyphCount > 0));
  }
  await ui.screenshot(`${artifact}.png`);
  assert.deepEqual(await page(), before);
  assert.deepEqual(await ui.invoke('service_list'), []);
  evidence = { result: capability ? 'NOT_RUN_PLATFORM_FONT_API' : 'PASS', preview: preview.directory, physical, viewport,
    sample, layout, fonts, capability, focusTrace };
} finally {
  await ui?.close();
  const resolved = await realpath(root);
  assert.equal(path.dirname(resolved), await realpath(tmpdir()));
  assert.ok(path.basename(resolved).startsWith(prefix));
  await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
await writeFile(`artifacts/${artifact}.json`, JSON.stringify(evidence, null, 2) + '\n');
console.log(`${evidence.result} real WebView platform font usage for a session tree row`);
