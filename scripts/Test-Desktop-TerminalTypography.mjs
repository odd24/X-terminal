import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchDesktop} from './lib/DesktopHarness.mjs';

const baseline=process.argv.includes('--baseline');
const previous=baseline?JSON.parse(await readFile('artifacts/log-status-timeout-preview.json','utf8')):undefined;
const executable=previous&&path.join(previous.directory,'shared-terminal-desktop.exe');
const directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-typography-ui-中文-'));
const prefix=baseline?'terminal-font-before':'terminal-font-after';
let ui;
try {
  ui=await launchDesktop(directory,{fixture:true,executable});
  await ui.click('新建合成会话');
  await ui.waitFor("document.querySelector('.status')?.textContent==='服务输出已同步'");
  const [connection]=await ui.invoke('service_list');
  const target={connection_id:connection.connection_id,generation:connection.generation};
  const sample=[
    'TTY 目录列表 · 0O 1lI 6789 · /var/log',
    '',
    '\x1b[1;32msynthetic@workbench\x1b[0m:~$ ls',
    '\x1b[1;34mandroid_platform\x1b[0m      \x1b[1;34mdevice_config\x1b[0m       \x1b[1;32mbuild-tools.sh\x1b[0m',
    '\x1b[1;34mkernel-6.6\x1b[0m            \x1b[1;34mlog_archive\x1b[0m         notes.txt',
    '\x1b[1;34mrelease_2026\x1b[0m          \x1b[1;34mserial_capture\x1b[0m      中文说明.txt',
    '',
    'RA|abcd|X regular',
    'RB|\x1b[1;32mabcd\x1b[0m|X bright',
    'RC|中文|X wide',
    '\x1b[1;32msynthetic@workbench\x1b[0m:~$ '
  ].join('\r\n');
  await ui.invoke('fixture_append',{connection:target,bytes:[...new TextEncoder().encode('\x1b[2J\x1b[H'+sample)]});
  const read=()=>ui.invoke('service_read_text',{connection:target,cursor:1});
  const original=await read();
  await ui.waitFor("document.querySelector('.xterm-rows').textContent.includes('RC|中文|X wide')");
  const measures={};
  for (const theme of ['dark','light']) {
    await ui.click('外观');
    await ui.fill('应用主题',theme);await ui.fill('终端配色','follow_theme');
    await ui.click('关闭外观');
    await ui.waitFor(`document.documentElement.dataset.theme==='${theme}'`);
    await ui.evaluate("document.querySelector('.xterm-helper-textarea').focus()");
    const measure=await ui.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('.xterm-rows > div')];
      const find=prefix=>rows.find(row=>row.textContent.startsWith(prefix));
      const markerX=row=>{
        const cursor=document.createTreeWalker(row,NodeFilter.SHOW_TEXT);
        while(cursor.nextNode()){
          const offset=cursor.currentNode.textContent.indexOf('X');
          if(offset<0)continue;
          const range=document.createRange();
          range.setStart(cursor.currentNode,offset);
          range.setEnd(cursor.currentNode,offset+1);
          return range.getBoundingClientRect().left;
        }
      };
      const regular=find('RA|'),bold=find('RB|'),wide=find('RC|');
      const boldCell=bold.querySelector('.xterm-bold');
      const plainCell=regular.firstElementChild;
      return {
        font:getComputedStyle(plainCell).fontFamily,
        size:getComputedStyle(plainCell).fontSize,
        regular:getComputedStyle(plainCell).fontWeight,
        bold:getComputedStyle(boldCell).fontWeight,
        boldColor:getComputedStyle(boldCell).color,
        plainColor:getComputedStyle(plainCell).color,
        pitch:bold.getBoundingClientRect().top-regular.getBoundingClientRect().top,
        markerColumns:[regular,bold,wide].map(markerX),
        viewport:document.querySelector('[aria-label="终端视口尺寸"]').textContent,
        dpi:devicePixelRatio
      };
    })()`);
    assert.equal(measure.size,'15px');
    assert.equal(measure.regular,'400');
    assert.equal(measure.bold,baseline?'700':'500');
    assert.equal(measure.pitch,baseline?18:19);
    assert.notEqual(measure.boldColor,measure.plainColor);
    assert.ok(measure.markerColumns.every(Number.isFinite));
    assert.ok(Math.max(...measure.markerColumns)-Math.min(...measure.markerColumns)<=1,'regular, bold, and CJK must align to terminal columns');
    measures[theme]=measure;
    await ui.screenshot(`${prefix}-${theme}.png`);
  }
  assert.deepEqual(await read(),original,'typography preserves service text');
  await writeFile(`artifacts/${prefix}.json`,JSON.stringify(measures,null,2));
  console.log(JSON.stringify(measures));
} finally {
  await ui?.close();
  assert.ok(path.basename(directory).startsWith('shared-terminal-typography-ui-中文-'));
  await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
