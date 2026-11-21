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
  const softwareSettings=version==='0.1.7';
  await page.command('Page.bringToFront');
  assert.deepEqual(await page.evaluate('[...document.querySelector(".app-bar").children].map(element=>element.className)'),
    ['0.1.5','0.1.6','0.1.7'].includes(version)?['sidebar-toggle','toolbar-log','toolbar-log-directory','tools-menu']:['sidebar-toggle','toolbar-log','tools-menu']);
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
