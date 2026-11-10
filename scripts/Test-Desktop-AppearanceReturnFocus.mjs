import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDesktop } from './lib/DesktopHarness.mjs';
import { activeText, desktopKeyboard } from './lib/DesktopKeyboard.mjs';

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

const prefix = 'shared-terminal-appearance-return-focus-中文-';
const artifact = 'P12-appearance-return-focus';
const root = await mkdtemp(path.join(tmpdir(), prefix));
const focusTrace = [];
const cases = [];
let ui;

try {
  ui = await launchDesktop(root, { executable: path.join(preview.directory, 'shared-terminal-desktop.exe') });
  await ui.command('Page.bringToFront');
  assert.equal((await ui.invoke('service_status')).fixture, false);
  const prefs = () => ui.invoke('config_request', { request: { op: 'preferences' } });
  const before = await prefs();
  assert.equal(before.result, 'preferences');
  const viewport = await ui.evaluate('({width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme})');
  assert.deepEqual(await ui.invoke('service_list'), []);
  const { key, enter, tabTo } = desktopKeyboard(ui, focusTrace);
  const observe = () => ui.evaluate(`(() => {
    const node=document.activeElement, css=getComputedStyle(node), box=node.getBoundingClientRect();
    return {tag:node.tagName,label:node.getAttribute('aria-label')??(node.matches('button,summary')?node.textContent.trim():null),
      insideAppearance:!!node.closest('dialog:modal[aria-label="外观设置"]'),
      toolsSummary:node===document.querySelector('.tools-menu > summary'),
      toolsOpen:document.querySelector('.tools-menu').open,
      visibleFocus:node!==document.body && node.matches(':focus-visible') && css.outlineStyle==='solid'
        && parseFloat(css.outlineWidth)>0 && node.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2))};
  })()`);

  for (const method of ['Escape', '关闭外观']) {
    const backward = await ui.evaluate(`Boolean(document.activeElement.compareDocumentPosition(document.querySelector('.tools-menu > summary')) & Node.DOCUMENT_POSITION_PRECEDING)`);
    await tabTo(activeText('更多工具'), `打开更多工具 ${method}`, { backward });
    await enter();
    await tabTo(activeText('外观'), '打开外观');
    await enter();
    await ui.waitFor(`!!document.querySelector('dialog:modal[aria-label="外观设置"]')`);
    const opened = await observe();
    assert.ok(opened.insideAppearance && opened.visibleFocus && !opened.toolsOpen);
    if (method === 'Escape') await key('Escape', 'Escape', 27);
    else {
      await tabTo(activeText('关闭外观'), '关闭外观按钮');
      await enter();
    }
    await ui.waitFor(`!document.querySelector('dialog:modal')`);
    const returned = await observe();
    const returnedToSummary = returned.toolsSummary && returned.visibleFocus && !returned.toolsOpen;
    if (!returnedToSummary && cases.length === 0) await ui.screenshot(`${artifact}-failure.png`);
    await key('Tab', 'Tab', 9);
    const next = await observe();
    cases.push({ method, opened, returned, next, passed: returnedToSummary && next.label === '新建SSH连接' && next.visibleFocus });
  }

  assert.deepEqual(await prefs(), before);
  assert.deepEqual(await ui.invoke('service_list'), []);
  const result = cases.every(item => item.passed) ? 'PASS' : 'FAIL';
  await writeFile(`artifacts/${artifact}.json`, JSON.stringify({ result, preview: preview.directory, viewport, cases, focusTrace }, null, 2) + '\n');
  assert.equal(result, 'PASS', 'Appearance close must return visible focus to 更多工具 before continuing with Tab');
} finally {
  await ui?.close();
  const resolved = await realpath(root);
  assert.equal(path.dirname(resolved), await realpath(tmpdir()));
  assert.ok(path.basename(resolved).startsWith(prefix));
  await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
