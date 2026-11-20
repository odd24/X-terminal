import type { ThemeChoice, TerminalFont } from './appearance';
import type { DesktopPreferences } from './config-api';
import { Field, Panel } from './ui';

export function AppearancePanel({ theme, font, setTheme, setFont, preferences, busy, canSave, message, update, save, read, close }: {
  theme: ThemeChoice; font: TerminalFont; setTheme: (theme: ThemeChoice) => void;
  preferences: DesktopPreferences; busy: boolean; canSave: boolean; message: string;
  update: (patch: Partial<DesktopPreferences>) => void; save: () => void; read: () => void;
  setFont: (font: TerminalFont) => void; close: () => void;
}) {
  return <Panel title="外观" close={close} closeLabel="关闭外观">
    <fieldset disabled={busy}><div className="form-grid">
      <Field label="应用主题"><select aria-label="应用主题" value={theme} onChange={event => setTheme(event.target.value as ThemeChoice)}>
        <option value="dark">深色</option><option value="light">浅色</option><option value="system">跟随系统</option>
      </select></Field>
      <Field label="终端配色"><select aria-label="终端配色" value={preferences.terminal_palette} onChange={event => update({ terminal_palette: event.target.value as DesktopPreferences['terminal_palette'] })}>
        <option value="follow_theme">跟随应用主题</option><option value="black_green">黑底绿字</option><option value="black_white">黑底白字</option><option value="x">X</option>
      </select></Field>
      <Field label="终端等宽字体"><select aria-label="终端等宽字体" value={font} onChange={event => setFont(event.target.value as TerminalFont)}>
        <option value="consolas">Consolas</option><option value="cascadia">Cascadia Mono（未安装时使用 Consolas）</option>
      </select></Field>
    </div>
    <label className="check"><input aria-label="Ctrl+C选区复制" type="checkbox" checked={preferences.ctrl_c_copy} onChange={event => update({ctrl_c_copy:event.target.checked})} />Ctrl+C有选区时复制；关闭后交给终端</label>
    <label className="check"><input aria-label="Ctrl+V粘贴" type="checkbox" checked={preferences.ctrl_v_paste} onChange={event => update({ctrl_v_paste:event.target.checked})} />Ctrl+V粘贴到当前终端</label>
    <p>右键打开终端日志菜单；粘贴请明确选择菜单项，或使用 Ctrl+Shift+V。</p>
    <div className="config-actions"><button disabled={!canSave} onClick={save}>保存桌面偏好</button><button onClick={read}>重新读取偏好</button></div>
    </fieldset>
    <div role="status" aria-label="桌面偏好状态">{message}</div>
    <small>调整立即作用于本窗口，保存后按当前数据目录恢复并纳入配置备份。重新读取会丢弃本窗口未保存的调整。中文使用系统字体回退，字号在工具栏调整。Ctrl+Shift+C/V及复制/粘贴按钮始终可用；无选区Ctrl+C仍发送终端中断。粘贴的预览与目标确认规则保持。草稿、正文和同意不保存。</small>
  </Panel>;
}
