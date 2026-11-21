import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop } from './lib/DesktopHarness.mjs';
import { activeText, desktopKeyboard } from './lib/DesktopKeyboard.mjs';

const matrix = process.argv.includes('--tools-matrix');
const manifest = process.argv.slice(2).find(argument => argument !== '--tools-matrix')
  ?? (matrix ? 'artifacts/P12-appearance-return-focus-preview.json' : 'artifacts/P12-standard-workspace-dpi-preview.json');
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

const scenario = matrix ? 'tools-modal-return-focus' : 'appearance-return-focus';
const prefix = `shared-terminal-${scenario}-中文-`;
const artifact = `P12-${scenario}`;
const root = await mkdtemp(path.join(tmpdir(), prefix));
const focusTrace = [];
const cases = [];
let ui;

try {
  ui = await launchDesktop(root, { executable: path.join(preview.directory, 'shared-terminal-desktop.exe') });
  await ui.command('Page.bringToFront');
  assert.equal((await ui.invoke('service_status')).fixture, false);
  const prefs = () => ui.invoke('config_request', { request: { op: 'preferences' } });
  const profiles = () => ui.invoke('config_request', { request: { op: 'page', revision: null, offset: 0, folders: false } });
  const workspaces = () => ui.invoke('config_request', { request: { op: 'workspaces' } });
  const before = await prefs();
  const emptyProfiles = matrix ? await profiles() : undefined;
  const emptyWorkspaces = matrix ? await workspaces() : undefined;
  if (matrix) {
    assert.deepEqual(emptyProfiles.profiles, []);
    assert.deepEqual(emptyWorkspaces.workspaces, []);
  }
  assert.equal(before.result, 'preferences');
  const viewport = await ui.evaluate('({width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme})');
  if (matrix) assert.deepEqual(viewport, { width: 1100, height: 760, theme: 'dark' });
  assert.deepEqual(await ui.invoke('service_list'), []);
  const { key, enter, tabTo } = desktopKeyboard(ui, focusTrace);
  const observe = () => ui.evaluate(`(() => {
    const node=document.activeElement, css=getComputedStyle(node), box=node.getBoundingClientRect();
    return {tag:node.tagName,label:node.getAttribute('aria-label')??(node.matches('button,summary')?node.textContent.trim():null),
      dialog:node.closest('dialog:modal')?.getAttribute('aria-label')??null,
      toolsSummary:node===document.querySelector('.tools-menu > summary'),
      toolsOpen:document.querySelector('.tools-menu').open,
      visibleFocus:node!==document.body && node.matches(':focus-visible') && css.outlineStyle==='solid'
        && parseFloat(css.outlineWidth)>0 && node.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2))};
  })()`);

  async function openFromTools(label) {
    const backward = await ui.evaluate(`Boolean(document.activeElement.compareDocumentPosition(document.querySelector('.tools-menu > summary')) & Node.DOCUMENT_POSITION_PRECEDING)`);
    await tabTo(activeText('更多工具'), `更多工具 → ${label}`, { backward });
    await enter();
    await tabTo(activeText(label), `打开${label}`);
    await enter();
  }

  const entries = matrix ? [
    ['上次关闭信息', '上次关闭信息', 'Escape'],
    ['另存保全信息', '另存保全信息', 'Escape'],
    ['工作区', '保存与打开工作区', 'Escape'],
    ['批量修改配置', '批量修改连接配置', 'Escape'],
    ['上次关闭信息', '上次关闭信息', '关闭退出信息'],
  ] : [['软件设置', '软件设置', 'Escape'], ['软件设置', '软件设置', '关闭软件设置']];
  for (const [entry, dialog, method] of entries) {
    await openFromTools(entry);
    await ui.waitFor(`document.querySelector('dialog:modal')?.getAttribute('aria-label')===${JSON.stringify(dialog)}`);
    const opened = await observe();
    const modalFocus = opened.dialog === dialog && opened.visibleFocus && !opened.toolsOpen;
    if (method === 'Escape') await key('Escape', 'Escape', 27);
    else {
      await tabTo(activeText(method), method);
      await enter();
    }
    await ui.waitFor(`!document.querySelector('dialog:modal')`);
    const returned = await observe();
    const returnedToSummary = returned.toolsSummary && returned.visibleFocus && !returned.toolsOpen;
    if (!returnedToSummary && cases.length === 0) await ui.screenshot(`${artifact}-failure.png`);
    if (returnedToSummary && cases.length === 0) await ui.screenshot(`${artifact}-summary.png`);
    await key('Tab', 'Tab', 9);
    const next = await observe();
    cases.push({ entry, method, opened, returned, next, passed: modalFocus && returnedToSummary && next.label === '新建SSH连接' && next.visibleFocus });
  }

  const regressions = [];
  if (cases.every(item => item.passed)) {
    if (matrix) {
      await openFromTools('软件设置');
      await ui.waitFor(`!!document.querySelector('dialog:modal[aria-label="软件设置"]')`);
      await key('Escape', 'Escape', 27);
      await ui.waitFor(`!document.querySelector('dialog:modal')`);
      const appearance = await observe();
      regressions.push({ source: '更多工具 → 外观', returned: appearance,
        passed: appearance.toolsSummary && appearance.visibleFocus && !appearance.toolsOpen });
    }
    const configDialog = `!!document.querySelector('dialog:modal[aria-label="连接配置"]')`;
    await openFromTools('连接配置');
    await ui.waitFor(configDialog);
    await key('Escape', 'Escape', 27);
    await ui.waitFor(`!document.querySelector('dialog:modal')`);
    const tools = await observe();
    regressions.push({ source: '更多工具 → 连接配置', returned: tools, passed: tools.toolsSummary && tools.visibleFocus && !tools.toolsOpen });

    await tabTo(activeText('会话导航'), '打开空会话树', { backward: true });
    await enter();
    await tabTo(activeText('新建连接配置'), '空会话树入口');
    await enter();
    await ui.waitFor(configDialog);
    await key('Escape', 'Escape', 27);
    await ui.waitFor(`!document.querySelector('dialog:modal')`);
    const tree = await observe();
    regressions.push({ source: '会话树 → 新建连接配置', returned: tree, passed: tree.label === '新建连接配置' && tree.visibleFocus });
  }

  assert.deepEqual(await prefs(), before);
  if (matrix) {
    assert.deepEqual(await profiles(), emptyProfiles);
    assert.deepEqual(await workspaces(), emptyWorkspaces);
  }
  assert.deepEqual(await ui.invoke('service_list'), []);
  const result = cases.every(item => item.passed) && regressions.every(item => item.passed) ? 'PASS' : 'FAIL';
  await writeFile(`artifacts/${artifact}.json`, JSON.stringify({ result, preview: preview.directory, viewport, cases, regressions, focusTrace }, null, 2) + '\n');
  assert.equal(result, 'PASS', 'Modal close must return visible focus to 更多工具 before continuing with Tab');
} finally {
  await ui?.close();
  const resolved = await realpath(root);
  assert.equal(path.dirname(resolved), await realpath(tmpdir()));
  assert.ok(path.basename(resolved).startsWith(prefix));
  await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
