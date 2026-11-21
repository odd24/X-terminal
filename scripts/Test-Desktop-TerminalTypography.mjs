import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchDesktop} from './lib/DesktopHarness.mjs';

const baseline=process.argv.includes('--baseline');
const pureBlack=process.argv.includes('--pure-black');
const previous=baseline?JSON.parse(await readFile('artifacts/log-status-timeout-preview.json','utf8')):undefined;
const executable=previous&&path.join(previous.directory,'shared-terminal-desktop.exe');
const directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-typography-ui-中文-'));
const prefix=pureBlack?'terminal-black-only':baseline?'terminal-font-before':'terminal-font-after';
let ui;
try {
  ui=await launchDesktop(directory,{fixture:true,executable});
  await ui.click('新建合成会话');
  await ui.waitFor("document.querySelector('.status')?.textContent==='服务输出已同步'");
  const [connection]=await ui.invoke('service_list');
  const target={connection_id:connection.connection_id,generation:connection.generation};
  if(pureBlack){
    const profile={id:crypto.randomUUID(),folder_id:null,name:'开发终端 · 合成配置',settings:{protocol:'ssh2',host:'127.0.0.1',port:22,username:'synthetic',auth:'password',encoding:'utf8'}};
    await ui.invoke('config_request',{request:{op:'save_profile',profile,credential:{action:'clear'}}});
    await ui.click('刷新会话树');
    const entry=`document.querySelector('[data-profile-id="${profile.id}"]')`;
    await ui.waitFor(`!!${entry}`);
    await ui.evaluate(`${entry}.click()`);
    await ui.waitFor(`${entry}.getAttribute('aria-pressed')==='true'`);
  }
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
    await ui.click('软件设置');
    await ui.fill('应用主题',theme);await ui.fill('终端配色','follow_theme');
    await ui.click('关闭软件设置');
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
    if(pureBlack){
      const selectedFill=theme==='dark'?'rgb(48, 70, 94)':'rgb(228, 233, 241)';
      const buttonFill=theme==='dark'?'rgb(32, 48, 68)':'rgb(255, 255, 255)';
      await ui.waitFor(`getComputedStyle(document.querySelector('.session-tree-list .selected')).backgroundColor===${JSON.stringify(selectedFill)}
        &&getComputedStyle(document.querySelector('.sidebar-toggle')).backgroundColor===${JSON.stringify(buttonFill)}`);
      measure.workspace=await ui.evaluate(`(()=>{
        const style=selector=>getComputedStyle(document.querySelector(selector));
        return {
          surfaces:[':root','.desktop-shell','.session-sidebar','.app-bar','.terminal-workspace','.terminal','.xterm-viewport','.terminal-footer'].map(selector=>style(selector).backgroundColor),
          weights:['.session-sidebar h2','.profile-summary > strong','.session-tree-list .selected','.connection-tab [role="tab"]','.app-bar .toolbar-log','.app-bar .tools-menu summary','.terminal-footer [role="status"]'].map(selector=>style(selector).fontWeight),
          selectionFill:style('.session-tree-list .selected').backgroundColor,
          selectionBorder:style('.session-tree-list .selected').borderTopColor,
          controlFill:style('.sidebar-toggle').backgroundColor,
          activeTabFill:style('.connection-tab:has([aria-selected="true"])').backgroundColor,
          tabBorder:style('.connection-tab:has([aria-selected="true"])').borderTopColor,
          separator:style('.terminal-footer').borderTopColor
        };
      })()`);
      assert.ok(measure.workspace.weights.every(value=>value==='400'));
      if(theme==='dark'){
        const black='rgb(0, 0, 0)';
        assert.deepEqual(measure.workspace.surfaces,[
          'rgb(16, 23, 32)','rgba(0, 0, 0, 0)','rgb(20, 31, 43)','rgb(20, 31, 43)',
          'rgba(0, 0, 0, 0)',black,black,'rgba(0, 0, 0, 0)'
        ]);
        assert.equal(measure.workspace.selectionFill,'rgb(48, 70, 94)');
        assert.equal(measure.workspace.controlFill,'rgb(32, 48, 68)');
        assert.equal(measure.workspace.selectionBorder,'rgb(132, 217, 202)');
        assert.equal(measure.workspace.activeTabFill,'rgb(16, 23, 32)');
        assert.equal(measure.workspace.tabBorder,'rgb(49, 64, 84)');
        assert.equal(measure.workspace.separator,'rgb(49, 64, 84)');
        assert.equal(measure.boldColor,'rgb(178, 235, 186)');
      }else{
        assert.equal(measure.workspace.surfaces[0],'rgb(238, 240, 243)');
        assert.equal(measure.workspace.surfaces[5],'rgb(255, 255, 255)');
      }
    }
    measures[theme]=measure;
    await ui.screenshot(`${prefix}-${theme}.png`);
  }
  if(pureBlack){
    await ui.click('软件设置');await ui.fill('应用主题','dark');await ui.click('关闭软件设置');
    await ui.waitFor(`document.documentElement.dataset.theme==='dark'`);
    await ui.evaluate("document.querySelector('.app-bar .tools-menu summary').focus()");
    await ui.command('Page.bringToFront');
    await ui.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await ui.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    assert.ok(await ui.evaluate("document.activeElement.matches(':focus-visible')&&getComputedStyle(document.activeElement).outlineStyle==='solid'"));
    await ui.evaluate("document.querySelector('.xterm-helper-textarea').focus()");
    await ui.command('Input.imeSetComposition',{text:'zhong wen',selectionStart:9,selectionEnd:9});
    await ui.waitFor("document.querySelector('.composition-view.active')?.textContent==='zhong wen'");
    assert.deepEqual(await ui.evaluate(`(()=>{
      const style=getComputedStyle(document.querySelector('.composition-view.active'));
      return [style.color,style.backgroundColor,style.outlineStyle];
    })()`),['rgb(16, 35, 55)','rgb(217, 236, 255)','solid']);
    await ui.screenshot('terminal-black-only-preedit.png');
    await ui.command('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
  }
  assert.deepEqual(await read(),original,'typography preserves service text');
  await writeFile(`artifacts/${prefix}.json`,JSON.stringify(measures,null,2));
  console.log(JSON.stringify(measures));
} finally {
  await ui?.close();
  assert.ok(path.basename(directory).startsWith('shared-terminal-typography-ui-中文-'));
  await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
