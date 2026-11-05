import type { ThemeChoice, TerminalFont } from './appearance';
import { Field, Panel } from './ui';

export function AppearancePanel({ theme, font, setTheme, setFont, close }: {
  theme: ThemeChoice; font: TerminalFont; setTheme: (theme: ThemeChoice) => void;
  setFont: (font: TerminalFont) => void; close: () => void;
}) {
  return <Panel title="外观" close={close} closeLabel="关闭外观">
    <div className="form-grid">
      <Field label="应用主题"><select aria-label="应用主题" value={theme} onChange={event => setTheme(event.target.value as ThemeChoice)}>
        <option value="dark">深色</option><option value="light">浅色</option><option value="system">跟随系统</option>
      </select></Field>
      <Field label="终端等宽字体"><select aria-label="终端等宽字体" value={font} onChange={event => setFont(event.target.value as TerminalFont)}>
        <option value="consolas">Consolas</option><option value="cascadia">Cascadia Mono（未安装时使用 Consolas）</option>
      </select></Field>
    </div>
    <small>统一应用于本窗口全部面板、快照和终端；中文使用系统字体回退。字号在工具栏调整。本窗口显示设置在重载后恢复默认。</small>
  </Panel>;
}
