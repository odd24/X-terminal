type DesktopShortcut = {kind:'cycle';step:1|-1}|{kind:'index';index:number}
  |{kind:'openLocal'|'sidebar'|'search'};

export function desktopShortcut(event:KeyboardEvent): DesktopShortcut|undefined {
  if(event.isComposing||event.keyCode===229||event.metaKey||event.getModifierState('AltGraph'))return;
  if(event.ctrlKey&&!event.altKey){
    if(event.key==='Tab')return {kind:'cycle',step:event.shiftKey?-1:1};
    if(!event.shiftKey)return;
    switch(event.key.toLowerCase()){
      case 't': return {kind:'openLocal'};
      case 'b': return {kind:'sidebar'};
      case 'f': return {kind:'search'};
    }
  }
  if(!event.altKey||event.ctrlKey||event.shiftKey)return;
  const digit=/^\d$/.test(event.key)?event.key:/^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1];
  if(digit!==undefined)return {kind:'index',index:(Number(digit)+9)%10};
}

export function shortcutEditor(target:EventTarget|null){
  return target instanceof Element&&!target.matches('.xterm-helper-textarea')
    && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog[open], [role="menu"], .adb-panel-body form');
}
