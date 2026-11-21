import type { ThemeChoice, TerminalFont } from './appearance';
import type { DesktopPreferences } from './config-api';
import type { ReactNode } from 'react';
import {useState} from 'react';
import { Field, Panel } from './ui';
import {LogViewerSettings} from './log-viewer-settings';

const sections=['外观','输入与剪贴板','日志'] as const;

export function SoftwareSettings({preferences, fontSizeControl, busy, canSave, message, update, save, read, close }: {
  preferences: DesktopPreferences; fontSizeControl: ReactNode; busy: boolean; canSave: boolean; message: string;
  update: (patch: Partial<DesktopPreferences>) => void; save: () => void; read: () => void;
  close: () => void;
}) {
  const [section,setSection]=useState<(typeof sections)[number]>('外观');
  const brightness=preferences.terminal_text_brightness??100;
  return <Panel title="软件设置" close={close} closeLabel="关闭软件设置">
    <nav className="settings-categories" aria-label="设置分类">
      {sections.map(name=><button type="button" key={name} aria-pressed={section===name} onClick={()=>setSection(name)}>{name}</button>)}
    </nav>
    {section==='日志'?<LogViewerSettings/>:<>
    <fieldset disabled={busy}>
    {section==='外观'?<div className="form-grid">
      <Field label="应用主题"><select aria-label="应用主题" value={preferences.theme} onChange={event => update({theme:event.target.value as ThemeChoice})}>
        <option value="dark">深色</option><option value="light">浅色</option><option value="system">跟随系统</option>
      </select></Field>
      <Field label="终端配色"><select aria-label="终端配色" value={preferences.terminal_palette} onChange={event => update({ terminal_palette: event.target.value as DesktopPreferences['terminal_palette'] })}>
        <option value="follow_theme">跟随应用主题</option><option value="black_green">黑底绿字</option><option value="black_white">黑底白字</option><option value="x">X</option>
      </select></Field>
      <Field label="终端等宽字体"><select aria-label="终端等宽字体" value={preferences.terminal_font} onChange={event => update({terminal_font:event.target.value as TerminalFont})}>
        <option value="consolas">Consolas</option><option value="cascadia">Cascadia Mono（未安装时使用 Consolas）</option>
      </select></Field>
      {fontSizeControl}
      <Field label={`终端文字亮度 · ${brightness}%`}>
        <input aria-label="终端文字亮度" type="range" min={40} max={100} step={1} value={brightness}
          aria-valuetext={`${brightness}%`} onChange={event=>update({terminal_text_brightness:event.currentTarget.valueAsNumber})} />
      </Field>
    </div>:<>
    <label className="check"><input aria-label="Ctrl+C选区复制" type="checkbox" checked={preferences.ctrl_c_copy} onChange={event => update({ctrl_c_copy:event.target.checked})} />Ctrl+C有选区时复制；关闭后交给终端</label>
    <label className="check"><input aria-label="Ctrl+V粘贴" type="checkbox" checked={preferences.ctrl_v_paste} onChange={event => update({ctrl_v_paste:event.target.checked})} />Ctrl+V粘贴到当前终端</label>
    <p>右键打开终端日志菜单；粘贴请明确选择菜单项，或使用 Ctrl+Shift+V。</p>
    </>}
    <div className="config-actions"><button disabled={!canSave} onClick={save}>保存桌面偏好</button><button onClick={read}>重新读取偏好</button></div>
    </fieldset>
    <div role="status" aria-label="桌面偏好状态">{message}</div>
    {section==='外观'?<small>字号自动保存。主题、字体、配色和亮度可即时预览，点击「保存桌面偏好」后保留。</small>:
      <small>输入偏好点击「保存桌面偏好」后保留。无选区时 Ctrl+C 发送终端中断。</small>}
    </>}
  </Panel>;
}
