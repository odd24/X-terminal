import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop } from './lib/DesktopHarness.mjs';
import { active, activeText, desktopKeyboard } from './lib/DesktopKeyboard.mjs';

const narrow = process.argv.includes('--narrow');
const maximized = process.argv.includes('--maximized');
assert.ok(!(narrow && maximized), 'Choose one workspace mode');
const manifest = process.argv.slice(2).find(argument => !['--narrow', '--maximized'].includes(argument))
  ?? 'artifacts/P12-standard-workspace-dpi-preview.json';
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

const mode = narrow ? 'narrow' : maximized ? 'maximized' : 'standard';
const prefix = `shared-terminal-${mode}-workspace-dpi-中文-`;
const root = await mkdtemp(path.join(tmpdir(), prefix));
const executable = path.join(preview.directory, 'shared-terminal-desktop.exe');
const artifact = narrow ? 'P12-narrow-tree-space' : `P12-${mode}-workspace-dpi`;
const sizes = narrow ? [[760, 540]] : maximized ? [[1920, 1080]] : [[1280, 720], [1920, 1080]];
const viewport = '({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,theme:document.documentElement.dataset.theme})';
const evidence = { preview: preview.directory, mode, sizes: [], focusTrace: [] };
let ui;

try {
  ui = await launchDesktop(root, { executable });
  await ui.command('Page.bringToFront');
  assert.equal((await ui.invoke('service_status')).fixture, false);
  const windowGeometry = (width, height, measureOnly = false) => JSON.parse(execFileSync('pwsh', ['-NoProfile', '-File',
    'scripts/lib/Resize-TestWindow.ps1', '-TargetProcessId', String(ui.app.pid), '-ExpectedExecutable', executable,
    '-Width', String(width), '-Height', String(height), '-PhysicalSize', ...(measureOnly ? ['-MeasureOnly'] : []),
    ...(maximized && !measureOnly ? ['-Maximize'] : [])],
  { encoding: 'utf8', windowsHide: true }));
  const initial = windowGeometry(...sizes[0], true);
  evidence.initial = initial;
  evidence.initialViewport = await ui.evaluate(viewport);
  assert.equal(initial.pid, ui.app.pid);
  const fits = ([width, height]) => width <= initial.availableWidth && height <= initial.availableHeight;
  const expectedEnvironment = initial.displayWidth === 1920 && initial.displayHeight === 1080 && initial.dpi === 96
    && evidence.initialViewport.dpr === 1 && evidence.initialViewport.theme === 'dark';
  evidence.sizes = sizes.map(([width, height]) => ({ width, height, kind: maximized ? 'display' : 'window',
    result: maximized ? (expectedEnvironment ? 'READY' : 'NOT_RUN_ENVIRONMENT') : (fits([width, height]) ? 'READY' : 'NOT_RUN_NO_FIT') }));
  await writeFile(`artifacts/${artifact}-preflight.json`, JSON.stringify(evidence, null, 2) + '\n');

  const list = () => ui.invoke('service_list');
  assert.deepEqual(await list(), []);
  if (evidence.sizes.some(item => item.result === 'READY')) {
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

    function focusedRowMeasurements() {
      return `const style=getComputedStyle(node), r=node.getBoundingClientRect();
        const clip={left:0,top:0,right:innerWidth,bottom:innerHeight};
        for(let parent=node.parentElement;parent;parent=parent.parentElement){
          const p=parent.getBoundingClientRect(), css=getComputedStyle(parent);
          const x=p.left+parent.clientLeft,y=p.top+parent.clientTop;
          if(css.overflowX!=='visible'){clip.left=Math.max(clip.left,x);clip.right=Math.min(clip.right,x+parent.clientWidth);}
          if(css.overflowY!=='visible'){clip.top=Math.max(clip.top,y);clip.bottom=Math.min(clip.bottom,y+parent.clientHeight);}
        }
        const top=Math.max(r.top,clip.top),bottom=Math.min(r.bottom,clip.bottom);
        const left=Math.max(r.left,clip.left),right=Math.min(r.right,clip.right);
        const focus={clip,visibleHeight:Math.max(0,bottom-top),
          rowFocus:node.matches(':focus-visible')&&document.activeElement===node,
          outline:style.outlineStyle,margin:parseFloat(style.outlineWidth)+parseFloat(style.outlineOffset),
          rowHit:right>left&&bottom>top&&node.contains(document.elementFromPoint((left+right)/2,(top+bottom)/2))};`;
    }

    async function geometry() {
      return ui.evaluate(`(() => {
        const nodes=Object.fromEntries(Object.entries(${JSON.stringify(controls)}).map(([key,selector])=>[key,document.querySelector(selector)]));
        const boxes=Object.fromEntries(Object.entries(nodes).map(([key,node])=>[key,node.getBoundingClientRect().toJSON()]));
        const node=nodes.row, tree=node.closest('.tree-scroll');
        ${focusedRowMeasurements()}
        const range=document.createRange(); range.selectNodeContents(nodes.row);
        return {boxes,...focus,lines:[...range.getClientRects()].map(rect=>rect.toJSON()),
          scroll:Object.fromEntries(['toolbar','tree','footer'].map(key=>[key,[nodes[key].scrollWidth,nodes[key].clientWidth]])),
          treeScroll:{top:tree.scrollTop,height:tree.clientHeight,content:tree.scrollHeight},position:getComputedStyle(nodes.tree).position};
      })()`);
    }

    function fullFocusOutline({ boxes: { row }, clip, rowHit, rowFocus, outline, margin }) {
      return rowHit && rowFocus && outline === 'solid' && margin === 4 && row.left - margin >= clip.left - 1
        && row.right + margin <= clip.right + 1 && row.top - margin >= clip.top - 1 && row.bottom + margin <= clip.bottom + 1;
    }

    const exceedsTreeHeight = ({ boxes: { row }, clip, margin }) => row.height + 2 * margin > clip.bottom - clip.top + 1;
    function visibleTreeFocus(result) {
      if (!narrow || !exceedsTreeHeight(result)) return fullFocusOutline(result);
      const { boxes: { row }, clip, rowFocus, rowHit, outline, margin, lines } = result;
      return rowFocus && rowHit && outline === 'solid' && margin === 4 && row.left - margin >= clip.left - 1
        && row.right + margin <= clip.right + 1 && lines.some(line => line.bottom > clip.top && line.top < clip.bottom);
    }

    async function reachSidebarControl(label) {
      await tabTo(active(`.session-sidebar input[aria-label="${label}"]`), label);
      const measured = await ui.evaluate(`(() => {
        const node=document.activeElement, sidebar=node.closest('.session-sidebar');
        ${focusedRowMeasurements()}
        const bounds=sidebar.getBoundingClientRect();
        return { focused:focus.rowFocus, hit:focus.rowHit, within:r.left>=bounds.left && r.right<=bounds.right
          && r.top>=bounds.top && r.bottom<=bounds.bottom && focus.visibleHeight===r.height };
      })()`);
      assert.deepEqual(measured, { focused: true, hit: true, within: true }, label);
      return measured;
    }

    const summary = 'document.querySelector(".profile-summary")';
    async function detailGeometry() {
      return ui.evaluate(`(() => {
        const summary=${summary}, node=summary.querySelector('button'), title=summary.querySelector('strong');
        ${focusedRowMeasurements()}
        return {boxes:{row:r.toJSON()},...focus,
          scrollTop:summary.scrollTop,scrollHeight:summary.scrollHeight,clientHeight:summary.clientHeight,
          scrollWidth:summary.scrollWidth,clientWidth:summary.clientWidth,title:title.getBoundingClientRect().toJSON()};
      })()`);
    }

    for (const item of evidence.sizes) {
      if (item.result !== 'READY') continue;
      const { width, height } = item;
      const physical = windowGeometry(width, height);
      item.physical = physical;
      assert.deepEqual([physical.pid, physical.hwnd, physical.dpi], [initial.pid, initial.hwnd, initial.dpi]);
      if (maximized) {
        assert.equal(physical.maximized, true);
        assert.deepEqual([physical.displayWidth, physical.displayHeight, physical.workWidth, physical.workHeight],
          [width, height, initial.workWidth, initial.workHeight]);
        assert.equal(physical.visibleMatchesWorkArea, true);
      } else assert.deepEqual([physical.width, physical.height], [width, height]);
      await ui.waitFor(`Math.abs(innerWidth*devicePixelRatio-${physical.clientWidth})<=devicePixelRatio
        && Math.abs(innerHeight*devicePixelRatio-${physical.clientHeight})<=devicePixelRatio`);
      item.viewport = await ui.evaluate(viewport);
      assert.equal(item.viewport.dpr, physical.dpi / 96);
      assert.equal(item.viewport.theme, evidence.initialViewport.theme);
      if (narrow) assert.deepEqual([physical.dpi, item.viewport.width, item.viewport.height, item.viewport.theme], [96, 744, 501, 'dark']);
      if (!await ui.evaluate(`document.querySelector('.sidebar-toggle').getAttribute('aria-expanded')==='true'`)) {
        await tabTo(activeText('会话导航'), '打开会话导航');
        await enter();
        await tabTo(`(${activeText('刷新会话树')}) && !document.activeElement.disabled`, '加载预置会话树');
        await enter();
      }
      await ui.waitFor(`!!document.querySelector(${JSON.stringify(row)})`);
      if (narrow) item.search = await reachSidebarControl('搜索会话配置');
      await tabTo(active(row), `长配置项 ${width}×${height}`);
      assert.equal(await ui.evaluate('document.activeElement.textContent'), profile.name);
      const result = item.geometry = await geometry();
      const { boxes, clip } = result;
      const problems = item.findings = [];
      for (const [label, r] of Object.entries(boxes)) {
        if (narrow && label === 'row') continue;
        if (r.left < 0 || r.top < 0 || r.right > item.viewport.width || r.bottom > item.viewport.height || !r.width || !r.height) {
          problems.push(`${label} is outside the visible workspace`);
        }
      }
      if (narrow) {
        assert.equal(result.position, 'absolute');
        assert.ok(boxes.tree.right > boxes.workspace.left, 'The narrow tree overlays the workspace');
        assert.ok(clip.bottom - clip.top > 36 && result.visibleHeight > 32, 'The unselected tree must improve on the 36px baseline');
      }
      if ((!narrow && boxes.tree.right > boxes.workspace.left) || boxes.toolbar.bottom > boxes.workspace.top || boxes.workspace.bottom > boxes.footer.top) {
        problems.push('Workspace regions overlap');
      }
      if (Object.values(result.scroll).some(([scroll, client]) => scroll > client)) problems.push('Horizontal overflow');
      if (result.lines.length < 2 || result.lines.some(r => r.left < clip.left || r.right > clip.right)) problems.push('Long name does not wrap within the tree');
      if (!visibleTreeFocus(result)) problems.push('Focused tree row is not visibly reachable');
      item.result = problems.length ? 'FAIL' : 'PASS';
      if ((!narrow && !maximized) || problems.length) await ui.screenshot(`${artifact}-${width}x${height}.png`);
      if (problems.length) break;
      await enter();
      await ui.waitFor(active(`${row}[aria-pressed="true"]`));
      assert.equal(await ui.evaluate(`document.querySelector('.profile-summary strong').textContent`), profile.name);
      const selected = await geometry();
      assert.ok(selected.rowFocus, 'Keyboard selection must retain focus on the original tree item');
      assert.ok(Object.values(selected.scroll).every(([scroll, client]) => scroll <= client), 'Selection must not create horizontal overflow');
      assert.deepEqual(await list(), [], 'Keyboard selection must not start a connection');
      item.selection = { selected: true, focused: selected.rowFocus, outlineVisible: fullFocusOutline(selected),
        row: selected.boxes.row, clip: selected.clip, scroll: selected.scroll,
        oversized: exceedsTreeHeight(selected), visibleHeight: selected.visibleHeight };
      if (narrow) {
        assert.ok(selected.clip.bottom - selected.clip.top > 36 && selected.visibleHeight > 32,
          'The selected tree must improve on the 36px baseline and 32px visible row');
        item.selection.mainGeometry = { workspace: selected.boxes.workspace, terminal: selected.boxes.terminal };
        assert.deepEqual(item.selection.mainGeometry, { workspace: boxes.workspace, terminal: boxes.terminal });
      }
      if (narrow || maximized || width === 1280) await ui.screenshot(`${artifact}-${width}x${height}-selected.png`);
      if (!visibleTreeFocus(selected)) {
        problems.push('Selection details reduce the tree viewport and clip the focused row');
        item.result = 'FAIL';
        break;
      }
      if (narrow && item.selection.oversized) {
        const scroll = 'document.querySelector(".tree-scroll")';
        await key('Home', 'Home', 36);
        await ui.waitFor(`${scroll}.scrollTop===0`);
        const first = await geometry();
        await key('End', 'End', 35);
        await ui.waitFor(`(() => {const tree=${scroll}; return tree.scrollTop>0 && tree.scrollHeight-tree.clientHeight-tree.scrollTop<1;})()`);
        const last = await geometry();
        assert.ok(first.lines[0].bottom > first.clip.top && first.lines[0].top < first.clip.bottom);
        assert.ok(last.lines.at(-1).bottom > last.clip.top && last.lines.at(-1).top < last.clip.bottom);
        assert.ok(first.rowFocus && last.rowFocus);
        item.selection.keyboardScroll = { first: first.treeScroll.top, last: last.treeScroll.top,
          firstVisibleHeight: first.visibleHeight, lastVisibleHeight: last.visibleHeight };
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
      if (narrow || maximized || width === 1280) await ui.screenshot(`${artifact}-${width}x${height}-details.png`);
      assert.deepEqual(await list(), [], 'Detail navigation must not start a connection');
      if (narrow) item.navigationWidth = await reachSidebarControl('导航宽度');
      await tabTo(active(row), '返回原配置项', { backward: true });
    }
    const after = await page();
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.profiles, before.profiles);
    assert.deepEqual(await list(), []);
    evidence.state = { configRevisionUnchanged: true, profilesUnchanged: true, sessions: 0 };
  }
  for (const item of evidence.sizes) if (item.result === 'READY') item.result = 'NOT_RUN_AFTER_FAILURE';
  evidence.result = evidence.sizes.some(item => item.result === 'FAIL') ? 'FAIL'
    : evidence.sizes.some(item => item.result === 'PASS') ? 'PASS' : evidence.sizes[0].result;
  await writeFile(`artifacts/${artifact}.json`, JSON.stringify(evidence, null, 2) + '\n');
  assert.notEqual(evidence.result, 'FAIL', 'See native geometry evidence for the workspace defect');
} catch (error) {
  evidence.result = 'FAIL';
  evidence.error = error.message;
  await writeFile(`artifacts/${artifact}.json`, JSON.stringify(evidence, null, 2) + '\n');
  throw error;
} finally {
  await ui?.close();
  const resolved = await realpath(root);
  assert.equal(path.dirname(resolved), await realpath(tmpdir()));
  assert.ok(path.basename(resolved).startsWith(prefix));
  await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
console.log(`${evidence.result} native ${mode} workspace at current DPI`);
