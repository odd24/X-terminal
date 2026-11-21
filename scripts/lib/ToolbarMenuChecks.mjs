import assert from 'node:assert/strict';

const q=selector=>'document.querySelector('+JSON.stringify(selector)+')';
const tools='.tools-menu > summary';
const surface='.tools-menu .tools-menu-content';
const escaped='Escape';

async function key(page,name){
  const vk={Escape:27,ArrowDown:40,Home:36,End:35}[name];
  for(const type of ['keyDown','keyUp'])
    await page.command('Input.dispatchKeyEvent',{type,key:name,code:name,windowsVirtualKeyCode:vk});
}

async function clickPoint(page,point,type){
  await page.command('Input.dispatchMouseEvent',{type,...point,button:'left',
    buttons:type==='mouseReleased'?0:1,clickCount:type==='mouseMoved'?0:1});
}

async function clickVisible(page,selector){
  const target=await page.evaluate(q(selector)+'.getBoundingClientRect().toJSON()');
  assert.ok(target.width&&target.height,selector);
  const point={x:target.left+target.width/2,y:target.top+target.height/2};
  await clickPoint(page,point,'mousePressed');await clickPoint(page,point,'mouseReleased');
}

export async function measurePopup(page,trigger,popup,label){
  await page.waitFor(`(()=>{
    const popup=${q(popup)},trigger=${q(trigger)};
    if(!popup?.dataset.positioned||!trigger||!popup.getClientRects().length)return false;
    const a=trigger.getBoundingClientRect(),b=popup.getBoundingClientRect();
    const gap=popup.dataset.positioned==='above'?a.top-b.bottom:b.top-a.bottom;
    const expectedX=Math.max(8,Math.min(a.left,innerWidth-b.width-8));
    return Math.abs(gap-4)<1&&Math.abs(b.left-expectedX)<1&&b.left>=7&&b.right<=innerWidth-7&&b.top>=7&&b.bottom<=innerHeight-7;
  })()`);
  const geometry=await page.evaluate(`(()=>{
    const a=${q(trigger)}.getBoundingClientRect(),node=${q(popup)},b=node.getBoundingClientRect();
    const placement=node.dataset.positioned;
    return {placement,gap:placement==='above'?a.top-b.bottom:b.top-a.bottom,
      anchorX:a.left,x:b.left,right:b.right,top:b.top,bottom:b.bottom,
      viewport:[innerWidth,innerHeight],overflow:node.scrollHeight>node.clientHeight};
  })()`);
  assert.ok(Math.abs(geometry.gap-4)<1,label+' gap '+JSON.stringify(geometry));
  const expectedX=Math.max(8,Math.min(geometry.anchorX,geometry.viewport[0]-(geometry.right-geometry.x)-8));
  assert.ok(Math.abs(geometry.x-expectedX)<1,label+' horizontal anchor');
  assert.ok(geometry.x>=7&&geometry.right<=geometry.viewport[0]-7,label+' horizontal clamp');
  assert.ok(geometry.top>=7&&geometry.bottom<=geometry.viewport[1]-7,label+' vertical clamp');
  return {label,...geometry};
}

export async function checkMainToolbar(page,fit,version='0.1.4'){
  const result=[];
  const compact=['0.1.10','0.1.11'].includes(version);
  const softwareSettings=compact||['0.1.7','0.1.8','0.1.9'].includes(version);
  await page.command('Page.bringToFront');
  assert.deepEqual(await page.evaluate('[...document.querySelector(".app-bar").children].map(element=>element.className)'),
    compact?['toolbar-log','toolbar-log-directory','tools-menu']:
      ['0.1.5','0.1.6'].includes(version)||softwareSettings?['sidebar-toggle','toolbar-log','toolbar-log-directory','tools-menu']:['sidebar-toggle','toolbar-log','tools-menu']);
  if(compact)assert.equal(await page.evaluate("document.querySelector('.window-chrome').firstElementChild.className"),'sidebar-toggle');
  for(const width of [1100,720]){
    await fit(width);
    await clickVisible(page,tools);
    result.push(await measurePopup(page,tools,surface,'more tools '+width));
    assert.equal(await page.evaluate(q('.toolbar-log')+'.disabled'),true);
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".toolbar-group h3")].map(item=>item.textContent)'),
      softwareSettings?['会话与终端','连接与布局','命令与自动化','诊断与退出']:['会话与终端','连接与布局','命令与自动化','外观','诊断与退出']);
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".toolbar-group:first-child button")].map(item=>item.textContent)'),['终端日志']);
    assert.equal(await page.evaluate('!!document.querySelector(\'.tools-menu select[aria-label="会话"]\')'),false);
    await page.screenshot('desktop-'+version+'-tools-'+width+'.png');
    await key(page,'ArrowDown');
    await page.waitFor('document.activeElement.textContent==="终端日志"');
    await key(page,'End');
    await page.waitFor('document.activeElement.textContent==="退出桌面" && '+q(surface)+'.scrollTop>0');
    result.push(await measurePopup(page,tools,surface,'scrolled tools '+width));
    await key(page,'Home');
    await page.waitFor('document.activeElement.textContent==="终端日志"');
    await key(page,escaped);
    await page.waitFor('!document.querySelector(".tools-menu").open && document.activeElement==='+q(tools));
    if(compact)assert.equal(await page.evaluate('getComputedStyle('+q(tools)+').outlineStyle'),'solid');
  }
  await clickVisible(page,'.sidebar-toggle');
  await page.waitFor('document.querySelector(".desktop-body").classList.contains("sidebar-hidden")');
  await clickVisible(page,tools);
  result.push(await measurePopup(page,tools,surface,'sidebar hidden'));
  await fit(900);
  result.push(await measurePopup(page,tools,surface,'resize with menu open'));
  await page.click(softwareSettings?'软件设置':'外观');
  const dialog='dialog:modal[aria-label="'+(softwareSettings?'软件设置':'外观设置')+'"]';
  await page.waitFor('!!'+q(dialog));
  const before=await page.evaluate(q(dialog)+'.getBoundingClientRect().toJSON()');
  const heading=await page.evaluate(q(dialog+' h2')+'.getBoundingClientRect().toJSON()');
  const start={x:heading.left+15,y:heading.top+heading.height/2};
  await clickPoint(page,start,'mousePressed');
  const end={x:start.x+30,y:start.y+35};
  await clickPoint(page,end,'mouseMoved');await clickPoint(page,end,'mouseReleased');
  assert.ok(await page.evaluate(q(dialog)+'.getBoundingClientRect().left>'+before.left));
  await key(page,escaped);
  await page.waitFor('!'+q(dialog)+' && document.activeElement==='+q(tools));
  await clickVisible(page,tools);await page.click('工作区');
  await page.waitFor('!!document.querySelector(\'dialog:modal[aria-label="保存与打开工作区"]\')');
  await key(page,escaped);
  await page.waitFor('!document.querySelector("dialog:modal") && document.activeElement==='+q(tools));
  await clickVisible(page,'.sidebar-toggle');
  await fit(1100);
  return result;
}

export async function measureCompactToolbar(page,detached=false){
  await page.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:95});
  await page.waitFor(`[...document.querySelectorAll('.window-chrome > .sidebar-toggle, .app-bar > button, .app-bar > .tools-menu > summary')]
    .every(node=>getComputedStyle(node).backgroundColor==='rgba(0, 0, 0, 0)')`);
  const result=await page.evaluate(`(()=>{
    const header=document.querySelector('.window-chrome'),nav=header.querySelector('.app-bar');
    const title=header.querySelector('.window-title'),sidebar=header.querySelector('.sidebar-toggle');
    const box=node=>node.getBoundingClientRect(),chrome=box(header),actions=box(nav),caption=box(header.querySelector('.window-buttons'));
    const nodeSizes=[...nav.children].map(child=>child.matches('details')?child.querySelector('summary'):child);
    if(sidebar)nodeSizes.unshift(sidebar);
    const controls=nodeSizes.map(node=>{
      const b=box(node),style=getComputedStyle(node);
      return {label:node.getAttribute('aria-label')??node.textContent.trim(),width:b.width,height:b.height,
        transparent:style.backgroundColor==='rgba(0, 0, 0, 0)',border:parseFloat(style.borderTopWidth),
        fits:b.left>=chrome.left&&b.right<=chrome.right&&b.top>=chrome.top&&b.bottom<=chrome.bottom};
    });
    return {viewport:[innerWidth,innerHeight],height:chrome.height,controls,gap:caption.left-actions.right,
      background:getComputedStyle(header).backgroundColor,navBackground:getComputedStyle(nav).backgroundColor,
      title:{text:title.textContent.trim(),weight:getComputedStyle(title).fontWeight,width:box(title).width,drag:title.hasAttribute('data-tauri-drag-region')},
      sidebarBeforeTitle:sidebar?.nextElementSibling===title,toolbarBottom:chrome.bottom,
      tabTops:[...document.querySelectorAll('.terminal-pane .pane-tab-bar')].map(node=>box(node).top),
      toolsHint:nav.querySelector('.tools-menu > summary')?.title??null};
  })()`);
  assert.equal(result.navBackground,'rgba(0, 0, 0, 0)');
  assert.ok(result.height>=37&&result.height<=41&&Math.abs(result.gap-20)<1,JSON.stringify(result));
  assert.deepEqual(result.controls.map(control=>control.label),detached?['日志','打开日志目录','移回主窗口']:['会话导航','日志','打开日志目录','更多工具']);
  assert.ok(result.controls.every(control=>control.fits&&control.border===0&&control.height===32&&control.transparent),JSON.stringify(result));
  assert.ok(result.controls.filter(control=>['会话导航','打开日志目录','更多工具'].includes(control.label)).every(control=>control.width===32));
  assert.equal(result.title.text,'共享终端');
  assert.equal(result.title.weight,'400');
  assert.equal(result.title.drag,true);
  assert.ok(result.title.width>=80);
  assert.equal(result.sidebarBeforeTitle,!detached);
  assert.equal(result.toolsHint,detached?null:'更多工具');
  assert.ok(result.tabTops.length>0&&result.tabTops.every(top=>top>=result.toolbarBottom),JSON.stringify(result));
  return result;
}

export async function checkNewConnectionMenu(page,selector){
  const trigger=selector+' .new-menu > summary',popup=selector+' .new-menu .tools-menu-content';
  await clickVisible(page,trigger);
  const results=[await measurePopup(page,trigger,popup,'split plus')];
  // Move only the synthetic trigger to the viewport corner to exercise the
  // flip and horizontal clamp, independent of the test monitor's dimensions.
  await page.evaluate(`(()=>{
    const trigger=${q(trigger)},box=trigger.getBoundingClientRect();
    trigger.style.transform='translate('+(innerWidth-box.right-2)+'px,'+(innerHeight-box.bottom-12)+'px)';
  })()`);
  await page.waitFor(q(popup)+'.dataset.positioned==="above"');
  results.push(await measurePopup(page,trigger,popup,'corner flip'));
  await page.screenshot('desktop-0.1.3-plus-flip.png');
  await page.evaluate(q(trigger)+'.style.transform=""');
  await key(page,escaped);
  await page.waitFor('!'+q(selector+' .new-menu')+'.open && document.activeElement==='+q(trigger));
  return results;
}

export async function checkLogToolbar(page,label,recordAction){
  const trigger='.toolbar-log',popup='.terminal-context-menu';
  await page.waitFor('!'+q(trigger)+'.disabled');
  await clickVisible(page,trigger);
  const result=await measurePopup(page,trigger,popup,label);
  if(recordAction)await page.waitFor(`[...document.querySelectorAll('.terminal-context-menu button')].some(button=>button.textContent===${JSON.stringify(recordAction)}&&!button.disabled)`);
  await key(page,escaped);
  await page.waitFor('!'+q(popup)+' && document.activeElement==='+q(trigger));
  return result;
}
