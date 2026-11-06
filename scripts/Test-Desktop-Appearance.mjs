import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchDesktop, delay } from './lib/DesktopHarness.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'shared-terminal-appearance-ui-中文-'));
let ui;
try {
  ui = await launchDesktop(directory, { fixture: true });
  await ui.click('新建合成会话');
  await ui.waitFor(`document.querySelector('.status').textContent==='服务输出已同步'`);
  const [connection] = await ui.invoke('service_list');
  const target = { connection_id: connection.connection_id, generation: connection.generation };
  const before = await ui.invoke('service_read_text', { connection: target, cursor: 1 });
  await ui.click('外观');
  await ui.click('查找终端');
  await ui.fill('终端查找文字', '中文宽字');
  await ui.click('下一个匹配');
  await ui.waitFor(`document.querySelector('[aria-label="终端查找状态"]').textContent.includes('1 / 1')`);
  for (const entry of ['连接配置', 'SSH2 连接', '串口连接', 'exec 任务', '终端日志']) await ui.click(entry);
  const checkTheme = async (theme, background, terminalBackground) => {
    await ui.fill('应用主题', theme);
    await ui.waitFor(`document.documentElement.dataset.theme===${JSON.stringify(theme)}`);
    const actual = await ui.evaluate(`(() => {
      const css=getComputedStyle(document.documentElement);
      return {
        page:css.backgroundColor,
        terminal:getComputedStyle(document.querySelector('.terminal')).backgroundColor,
        viewport:getComputedStyle(document.querySelector('.xterm-viewport')).backgroundColor,
        numberWidth:document.querySelector('[aria-label="字号"]').clientWidth,
        panels:[...document.querySelectorAll('.config-panel')].map(panel=>getComputedStyle(panel).backgroundColor),
        surface:css.getPropertyValue('--surface').trim(),
        font:css.fontFamily,
        controlFonts:[...document.querySelectorAll('button,input,select')].map(control=>getComputedStyle(control).fontFamily),
        mono:getComputedStyle(document.querySelector('.xterm-char-measure-element')).fontFamily,
        snapshots:[...document.querySelectorAll('pre')].map(pre=>getComputedStyle(pre).fontFamily)
      };
    })()`);
    assert.equal(actual.page, background);
    assert.equal(actual.terminal, terminalBackground);
    assert.equal(actual.viewport, terminalBackground);
    assert.ok(actual.numberWidth >= 70, 'number spinner must leave room for both digits');
    assert.ok(actual.panels.length >= 5, 'existing panels must participate in the shared theme');
    assert.equal(new Set(actual.panels).size, 1);
    assert.ok(actual.controlFonts.every(font => font === actual.font), 'all native form controls use the UI fallback chain');
    assert.ok(actual.mono.includes('Consolas'));
    assert.ok(actual.snapshots.every(font => font.includes('Consolas')));
  };
  await checkTheme('dark', 'rgb(16, 23, 32)', 'rgb(16, 23, 32)');
  await ui.screenshot('desktop-appearance-dark-native.png');
  await checkTheme('light', 'rgb(243, 245, 248)', 'rgb(255, 255, 255)');
  await ui.screenshot('desktop-appearance-light-native.png');
  // Actual keyboard focus must be visible on the next shared select control.
  await ui.evaluate(`document.querySelector('[aria-label="应用主题"]').focus()`);
  await ui.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await ui.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.equal(await ui.evaluate(`document.activeElement.getAttribute('aria-label')`), '终端配色');
  assert.equal(await ui.evaluate(`getComputedStyle(document.activeElement).outlineStyle`), 'solid');
  await ui.fill('终端等宽字体', 'cascadia');
  await ui.waitFor(`getComputedStyle(document.querySelector('.xterm-char-measure-element')).fontFamily.startsWith('"Cascadia Mono"')`);
  await ui.fill('字号', 20);
  await ui.waitFor(`getComputedStyle(document.querySelector('.xterm-char-measure-element')).fontSize==='20px'`);
  await ui.fill('应用主题', 'system');
  for (const colorScheme of ['dark', 'light']) {
    await ui.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: colorScheme }] });
    await ui.waitFor(`document.documentElement.dataset.theme===${JSON.stringify(colorScheme)}`);
  }
  await ui.click('关闭查找');
  await ui.click('关闭外观');
  // These are explicit CSS viewport probes, not native resolution / DPI claims.
  for (const [width, height] of [[1280, 720], [1920, 1080], [720, 480]]) {
    await ui.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await delay(100);
    assert.equal(await ui.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'no page-level horizontal overflow');
    await ui.screenshot(`desktop-appearance-light-viewport-${width}x${height}.png`);
  }
  assert.deepEqual(await ui.invoke('service_read_text', { connection: target, cursor: 1 }), before, 'appearance changes do not mutate raw-derived text or source identity');
  await ui.command('Emulation.clearDeviceMetricsOverride');
  await ui.command('Page.reload');
  await ui.waitFor(`document.querySelector('footer')?.textContent.includes('服务 ')`);
  await ui.waitFor(`document.documentElement.dataset.theme==='dark'`);
  assert.equal(await ui.evaluate(`document.querySelector('[aria-label="字号"]').value`), '15');
  assert.equal((await ui.invoke('service_list'))[0].connection_id, target.connection_id);
  console.log('PASS appearance native WebView: shared dark/light panels/controls, independent UI/terminal fallback fonts, actual Tab focus, global terminal font/size, live system theme, source text unchanged, reload defaults; 3 CSS viewport probes (not native DPI); synthetic only');
} finally {
  await ui?.close();
  await rm(directory, { recursive: true, force: true });
}
