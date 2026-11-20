import type { ITheme, ITerminalOptions } from '@xterm/xterm';

export type ThemeChoice = 'dark' | 'light' | 'system';
export type TerminalFont = 'consolas' | 'cascadia';

// CSS is the only owner of colors and font fallback chains.
export function terminalAppearance(): Pick<ITerminalOptions, 'fontFamily' | 'theme' | 'fontWeight' | 'fontWeightBold' | 'lineHeight'> {
  const style = getComputedStyle(document.documentElement);
  const keys = ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground',
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;
  const theme: ITheme = Object.fromEntries(keys.map(key => [key,
    style.getPropertyValue('--terminal-' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())).trim()]));
  return {
    fontFamily: style.getPropertyValue('--font-terminal').trim(),
    theme,
    fontWeight: 400,
    fontWeightBold: 500,
    lineHeight: 1.06,
  };
}
