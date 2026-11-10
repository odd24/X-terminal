import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop } from './lib/DesktopHarness.mjs';
import { active, activeText, desktopKeyboard } from './lib/DesktopKeyboard.mjs';

const manifest = process.argv[2] ?? 'artifacts/P12-standard-workspace-dpi-preview.json';
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

const prefix = 'shared-terminal-standard-workspace-dpi-中文-';
const root = await mkdtemp(path.join(tmpdir(), prefix));
const executable = path.join(preview.directory, 'shared-terminal-desktop.exe');
const artifact = 'P12-standard-workspace-dpi';
const sizes = [[1280, 720], [1920, 1080]];
const viewport = '({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,theme:document.documentElement.dataset.theme})';
const evidence = { preview: preview.directory, sizes: [], focusTrace: [] };
let ui;

try {
  ui = await launchDesktop(root, { executable });
  await ui.command('Page.bringToFront');
  assert.equal((await ui.invoke('service_status')).fixture, false);
  const windowGeometry = (width, height, measureOnly = false) => JSON.parse(execFileSync('pwsh', ['-NoProfile', '-File',
    'scripts/lib/Resize-TestWindow.ps1', '-TargetProcessId', String(ui.app.pid), '-ExpectedExecutable', executable,
    '-Width', String(width), '-Height', String(height), '-PhysicalSize', ...(measureOnly ? ['-MeasureOnly'] : [])],
  { encoding: 'utf8', windowsHide: true }));
  const initial = windowGeometry(...sizes[0], true);
  evidence.initial = initial;
  evidence.initialViewport = await ui.evaluate(viewport);
  assert.equal(initial.pid, ui.app.pid);
  const fits = ([width, height]) => width <= initial.availableWidth && height <= initial.availableHeight;
  evidence.sizes = sizes.map(([width, height]) => ({ width, height,
    result: fits([width, height]) ? 'READY' : 'NOT_RUN_NO_FIT' }));
  await writeFile(`artifacts/${artifact}-preflight.json`, JSON.stringify(evidence, null, 2) + '\n');

  const list = () => ui.invoke('service_list');
  assert.deepEqual(await list(), []);
  if (sizes.some(fits)) {
    const config = request => ui.invoke('config_request', { request });
    const page = () => config({ op: 'page', revision: null, offset: 0, folders: false });
    assert.deepEqual((await page()).profiles, []);
    const profile = { id: crypto.randomUUID(), folder_id: null, name: `标准工作区合成配置-${'longconfig'.repeat(11)}-end`,
      settings: { protocol: 'ssh2', host: 'workspace-layout.invalid', port: 22, username: 'synthetic', auth: 'password', encoding: 'utf8' } };
    const saved = await config({ op: 'save_profile', profile, credential: { action: 'clear' } });
    assert.equal(saved.result, 'saved_profile');
    assert.equal(saved.profile.credential_ref, null);
    const before = await page();
    const row = `.session-tree-list button[data-profile-id="${profile.id}"]`;
    const { enter, key, tabTo } = desktopKeyboard(ui, evidence.focusTrace);
    const controls = { toolbar: 'nav[aria-label="会话控制"]', tree: '.session-sidebar', row,
      workspace: '.terminal-workspace', terminal: '.terminal-pane .terminal', footer: 'footer', status: 'footer .connection-summary' };

    async function geometry() {
      return ui.evaluate(`(() => {
        const nodes=Object.fromEntries(Object.entries(${JSON.stringify(controls)}).map(([key,selector])=>[key,document.querySelector(selector)]));
        const boxes=Object.fromEntries(Object.entries(nodes).map(([key,node])=>[key,node.getBoundingClientRect().toJSON()]));
        const tree=nodes.row.closest('.tree-scroll'), r=tree.getBoundingClientRect(), style=getComputedStyle(nodes.row);
        const clip={left:r.left+tree.clientLeft,right:r.left+tree.clientLeft+tree.clientWidth,
          top:r.top+tree.clientTop,bottom:r.top+tree.clientTop+tree.clientHeight};
        const range=document.createRange(); range.selectNodeContents(nodes.row);
        return {boxes,clip,lines:[...range.getClientRects()].map(rect=>rect.toJSON()),
          scroll:Object.fromEntries(['toolbar','tree','footer'].map(key=>[key,[nodes[key].scrollWidth,nodes[key].clientWidth]])),
          rowFocus:nodes.row.matches(':focus-visible')&&document.activeElement===nodes.row,
          outline:style.outlineStyle,margin:parseFloat(style.outlineWidth)+parseFloat(style.outlineOffset),
          rowHit:nodes.row.contains(document.elementFromPoint((boxes.row.left+boxes.row.right)/2,(boxes.row.top+boxes.row.bottom)/2))};
      })()`);
    }

    function fullFocusOutline({ boxes: { row }, clip, rowHit, rowFocus, outline, margin }) {
      return rowHit && rowFocus && outline === 'solid' && margin === 4 && row.left - margin >= clip.left - 1
        && row.right + margin <= clip.right + 1 && row.top - margin >= clip.top - 1 && row.bottom + margin <= clip.bottom + 1;
    }

    const summary = 'document.querySelector(".profile-summary")';
    async function detailGeometry() {
      return ui.evaluate(`(() => {
        const summary=${summary}, button=summary.querySelector('button'), title=summary.querySelector('strong');
        const area=summary.getBoundingClientRect(), row=button.getBoundingClientRect(), style=getComputedStyle(button);
        const x=area.left+summary.clientLeft,y=area.top+summary.clientTop;
        return {boxes:{row:row.toJSON()},clip:{left:x,right:x+summary.clientWidth,top:y,bottom:y+summary.clientHeight},
          scrollTop:summary.scrollTop,scrollHeight:summary.scrollHeight,clientHeight:summary.clientHeight,
          scrollWidth:summary.scrollWidth,clientWidth:summary.clientWidth,title:title.getBoundingClientRect().toJSON(),
          rowFocus:document.activeElement===button&&button.matches(':focus-visible'),outline:style.outlineStyle,
          margin:parseFloat(style.outlineWidth)+parseFloat(style.outlineOffset),
          rowHit:button.contains(document.elementFromPoint((row.left+row.right)/2,(row.top+row.bottom)/2))};
      })()`);
    }

    for (const item of evidence.sizes) {
      if (item.result !== 'READY') continue;
      const { width, height } = item;
      const physical = windowGeometry(width, height);
      item.physical = physical;
      assert.deepEqual([physical.pid, physical.hwnd, physical.width, physical.height, physical.dpi],
        [initial.pid, initial.hwnd, width, height, initial.dpi]);
      await ui.waitFor(`Math.abs(innerWidth*devicePixelRatio-${physical.clientWidth})<=devicePixelRatio
        && Math.abs(innerHeight*devicePixelRatio-${physical.clientHeight})<=devicePixelRatio`);
      item.viewport = await ui.evaluate(viewport);
      assert.equal(item.viewport.dpr, physical.dpi / 96);
      assert.equal(item.viewport.theme, evidence.initialViewport.theme);
      if (!await ui.evaluate(`document.querySelector('.app-bar button').getAttribute('aria-expanded')==='true'`)) {
        await tabTo(activeText('会话导航'), '打开会话导航');
        await enter();
        await tabTo(`(${activeText('刷新会话树')}) && !document.activeElement.disabled`, '加载预置会话树');
        await enter();
      }
      await ui.waitFor(`!!document.querySelector(${JSON.stringify(row)})`);
      await tabTo(active(row), `长配置项 ${width}×${height}`);
      assert.equal(await ui.evaluate('document.activeElement.textContent'), profile.name);
      const result = item.geometry = await geometry();
      const { boxes, clip } = result;
      const problems = item.findings = [];
      for (const [label, r] of Object.entries(boxes)) {
        if (r.left < 0 || r.top < 0 || r.right > item.viewport.width || r.bottom > item.viewport.height || !r.width || !r.height) {
          problems.push(`${label} is outside the visible workspace`);
        }
      }
      if (boxes.tree.right > boxes.workspace.left || boxes.toolbar.bottom > boxes.workspace.top || boxes.workspace.bottom > boxes.footer.top) {
        problems.push('Workspace regions overlap');
      }
      if (Object.values(result.scroll).some(([scroll, client]) => scroll > client)) problems.push('Horizontal overflow');
      if (result.lines.length < 2 || result.lines.some(r => r.left < clip.left || r.right > clip.right)) problems.push('Long name does not wrap within the tree');
      if (!fullFocusOutline(result)) problems.push('Session tree focus outline is clipped or obscured');
      item.result = problems.length ? 'FAIL' : 'PASS';
      await ui.screenshot(`${artifact}-${width}x${height}.png`);
      if (problems.length) break;
      await enter();
      await ui.waitFor(active(`${row}[aria-pressed="true"]`));
      assert.equal(await ui.evaluate(`document.querySelector('.profile-summary strong').textContent`), profile.name);
      const selected = await geometry();
      assert.ok(selected.rowFocus, 'Keyboard selection must retain focus on the original tree item');
      assert.ok(Object.values(selected.scroll).every(([scroll, client]) => scroll <= client), 'Selection must not create horizontal overflow');
      assert.deepEqual(await list(), [], 'Keyboard selection must not start a connection');
      item.selection = { selected: true, focused: selected.rowFocus, outlineVisible: fullFocusOutline(selected),
        row: selected.boxes.row, clip: selected.clip, scroll: selected.scroll };
      if (width === 1280) await ui.screenshot(`${artifact}-${width}x${height}-selected.png`);
      if (!item.selection.outlineVisible) {
        problems.push('Selection details reduce the tree viewport and clip the focused row');
        item.result = 'FAIL';
        break;
      }
      await tabTo(activeText('连接选中配置'), '只聚焦连接选中配置');
      const focused = await detailGeometry();
      assert.ok(fullFocusOutline(focused), 'The existing connect control must scroll into view with its focus outline');
      assert.ok(focused.scrollWidth <= focused.clientWidth, 'Selected details must not overflow horizontally');
      assert.ok(focused.scrollHeight > focused.clientHeight && focused.scrollTop > 0, 'The long details scroll independently');
      await key('Home', 'Home', 36);
      await ui.waitFor(`${summary}.scrollTop===0`);
      const top = await detailGeometry();
      assert.ok(top.title.top >= top.clip.top && top.title.top < top.clip.bottom, 'Keyboard scrolling reveals the profile name');
      await key('End', 'End', 35);
      await ui.waitFor(`${summary}.scrollTop>0`);
      await ui.waitFor(`(() => { const panel=${summary}; return panel.scrollHeight-panel.clientHeight-panel.scrollTop<1; })()`);
      const bottom = await detailGeometry();
      assert.ok(fullFocusOutline(bottom), 'Keyboard scrolling returns to the complete connect control');
      item.details = { focused, top, bottom };
      if (width === 1280) await ui.screenshot(`${artifact}-${width}x${height}-details.png`);
      assert.deepEqual(await list(), [], 'Detail navigation must not start a connection');
      await tabTo(active(row), '返回原配置项', { backward: true });
    }
    const after = await page();
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.profiles, before.profiles);
    assert.deepEqual(await list(), []);
  }
  for (const item of evidence.sizes) if (item.result === 'READY') item.result = 'NOT_RUN_AFTER_FAILURE';
  evidence.result = evidence.sizes.some(item => item.result === 'FAIL') ? 'FAIL'
    : evidence.sizes.some(item => item.result === 'PASS') ? 'PASS' : 'NOT_RUN_NO_FIT';
  await writeFile(`artifacts/${artifact}.json`, JSON.stringify(evidence, null, 2) + '\n');
  assert.notEqual(evidence.result, 'FAIL', 'See native geometry evidence for the workspace defect');
} finally {
  await ui?.close();
  const resolved = await realpath(root);
  assert.equal(path.dirname(resolved), await realpath(tmpdir()));
  assert.ok(path.basename(resolved).startsWith(prefix));
  await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
console.log(`${evidence.result} native standard workspace sizes at current DPI`);
