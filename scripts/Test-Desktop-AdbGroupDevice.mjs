import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { delay, launchDesktop } from './lib/DesktopHarness.mjs';

const [executable, adb, reportFile] = process.argv.slice(2).map(file => path.resolve(file));
const approved = process.env.SHARED_TERMINAL_APPROVED_ADB_DEVICE;
assert.ok(executable && adb && reportFile && approved && /^[A-Za-z0-9._:-]{1,128}$/.test(approved),
  'one explicitly approved Android device is required');
const temp = await realpath(tmpdir());
const root = await mkdtemp(path.join(temp, 'shared-terminal-adb-group-device-中文-'));
const report = {
  result: 'IN_PROGRESS', executable,
  sha256: createHash('sha256').update(await readFile(executable)).digest('hex'),
  commands: ['adb get-state', 'adb shell', 'pwd', 'exit'],
};
let ui;
const output = "document.querySelector('.local-terminal:not([hidden]) .local-terminal-output')?.innerText";
const active = "[data-pane].pane-active";

async function key(key, windowsVirtualKeyCode) {
  for (const type of ['keyDown', 'keyUp']) {
    await ui.command('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode });
  }
}

async function tool(label) {
  await ui.evaluate("document.querySelector('.tools-menu').open=true");
  await ui.click(label);
}

try {
  const inventory = execFileSync(adb, ['devices'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    .split(/\r?\n/).filter(line => line.trim() && line.trim() !== 'List of devices attached');
  assert.equal(inventory.length, 1, 'require exactly one connected device');
  const [serial, state] = inventory[0].trim().split(/\s+/);
  assert.ok(serial === approved && state === 'device', 'only the specific approved device may be used');
  ui = await launchDesktop(root, { executable });
  const owner = await ui.invoke('service_status');
  assert.equal(owner.fixture, false);
  const group = {
    id: randomUUID(), name: '只读设备验证', desktop_kind: 'local',
    command: `adb -s ${serial} get-state\nadb -s ${serial} shell`,
  };
  await ui.invoke('local_adb_settings', { settings: { revision: null, executable: adb, shortcuts: [group] } });
  await ui.command('Page.reload');
  await tool('轻量命令行');
  await ui.waitFor(`!!document.querySelector('${active} .adb-panel-toggle')`);
  if (!await ui.evaluate(`!!document.querySelector('${active} .adb-shortcut-panel:not([hidden])')`)) {
    await ui.click('快捷指令');
  }
  const run = `document.querySelector(${JSON.stringify('.adb-shortcut-panel:not([hidden]) .adb-shortcut-run[aria-label=只读设备验证]')})`;
  await ui.waitFor(`!!${run}`);
  await ui.evaluate(`${run}.click()`);
  await ui.waitFor(`/^device\\s*$/m.test(${output}??'')&&/[#$]\\s*$/.test(${output}??'')`);
  await ui.waitFor("document.activeElement?.matches('.local-terminal:not([hidden]) .xterm-helper-textarea')");
  report.realPrompt = true;
  await ui.command('Input.insertText', { text: 'pwd' });
  await ui.waitFor(`/[#$] pwd\\s*$/.test(${output}??'')`);
  report.typedEcho = true;
  await key('Enter', 13);
  await ui.waitFor(`/^\\s*\\/[^\\r\\n]*$/m.test(${output}??'')&&/[#$]\\s*$/.test(${output}??'')`);
  report.pwdReturned = true;
  await ui.command('Input.insertText', { text: 'exit' });
  await key('Enter', 13);
  await ui.waitFor(`${output}?.includes('前台进程退出（0）')`);
  report.exitCode = 0;
  await tool('退出桌面');
  await ui.waitFor('!!document.querySelector("dialog[aria-label=退出桌面确认]")');
  await ui.click('确认退出并停止服务');
  for (let attempt = 0; attempt < 160 && ui.app.exitCode === null; attempt++) await delay(50);
  assert.equal(ui.app.exitCode, 0);
  const receipt = JSON.parse(await readFile(path.join(root, 'desktop-close-receipts-v1', owner.service_id + '.json'), 'utf8'));
  assert.equal(receipt.shutdown_ack, 'ACKNOWLEDGED');
  assert.equal(receipt.exit_code, 0);
  await ui.close();
  ui = undefined;
  report.result = 'PASS';
  console.log('PASS one authorized Android device, interactive prompt and echo, pwd, exit 0 and owned desktop shutdown');
} catch (error) {
  report.result = 'FAIL';
  report.error = String(error.message).replaceAll(approved, '[DEVICE]');
  throw new Error(report.error);
} finally {
  await ui?.close();
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  assert.equal(path.dirname(root), temp);
  assert.ok(path.basename(root).startsWith('shared-terminal-adb-group-device-中文-'));
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
