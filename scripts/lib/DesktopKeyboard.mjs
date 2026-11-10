import assert from 'node:assert/strict';

export const terminalInput = 'textarea.xterm-helper-textarea';
const visibleFocus = 'document.activeElement.getClientRects().length>0';
export const active = selector => `document.activeElement?.matches(${JSON.stringify(selector)}) && ${visibleFocus}`;
export const activeText = text => `document.activeElement?.textContent.trim()===${JSON.stringify(text)} && ${visibleFocus}`;

export function desktopKeyboard(ui, focusTrace) {
  async function key(key, code, virtualKey, { modifiers = 0, text } = {}) {
    const event = { key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, modifiers };
    await ui.command('Input.dispatchKeyEvent', { type: 'keyDown', ...event, ...(text ? { text, unmodifiedText: text } : {}) });
    await ui.command('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
  }
  async function type(text) {
    for (const character of text) {
      const code = /^[a-z]$/.test(character) ? `Key${character.toUpperCase()}`
        : /^\d$/.test(character) ? `Digit${character}` : { '.': 'Period', '-': 'Minus' }[character];
      assert.ok(code, 'synthetic keyboard input must use the supported ASCII keys');
      const virtualKey = { '.': 190, '-': 189 }[character] ?? character.toUpperCase().charCodeAt(0);
      await key(character, code, virtualKey, { text: character });
    }
  }
  async function recordFocus(step) {
    const observed = await ui.evaluate(`(()=>{
      const item=document.activeElement;
      return {tag:item?.tagName,label:item?.getAttribute('aria-label')??(item?.matches('button,summary')?item.textContent.trim():null)};
    })()`);
    focusTrace.push({ step, ...observed });
  }
  async function tabTo(condition, label, { backward = false } = {}) {
    for (let count = 0; count < 32; count++) {
      if (await ui.evaluate(condition)) return;
      assert.ok(!await ui.evaluate(active(terminalInput)), `focus entered terminal before reaching ${label}`);
      await key('Tab', 'Tab', 9, { modifiers: backward ? 8 : 0 });
      await recordFocus(label);
    }
    throw new Error(`Keyboard focus did not reach ${label}`);
  }
  const enter = () => key('Enter', 'Enter', 13, { text: '\r' });
  return { key, type, enter, tabTo, recordFocus };
}
