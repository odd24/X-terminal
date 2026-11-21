import { useEffect, useState, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

const windowHandle = getCurrentWindow();

export function WindowChrome({ detached, rail, children }: {
  detached: boolean;
  rail(node: HTMLDivElement | null): void;
  children: ReactNode;
}) {
  const [maximized, setMaximized] = useState(false);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () => void windowHandle.isMaximized().then(value => {
      if (active) setMaximized(value);
    }).catch(() => {});
    refresh();
    const subscription = windowHandle.onResized(refresh);
    return () => { active = false; void subscription.then(stop => stop()).catch(() => {}); };
  }, []);
  function action(operation: () => Promise<void>) {
    setProblem('');
    void operation().catch(() => setProblem('窗口操作未完成。'));
  }
  return <header className="window-chrome" aria-label="窗口标题栏">
    <div className="window-title" title={detached ? '共享终端 · 独立会话' : '共享终端'} data-tauri-drag-region="">
      共享终端
    </div>
    <div className="window-tab-slot" ref={rail} />
    <div className="window-drag-space" data-tauri-drag-region="" aria-hidden="true" />
    {children}
    <div className="window-buttons" aria-label="窗口控制">
      <button type="button" aria-label="最小化窗口" title="最小化" onClick={() => action(() => windowHandle.minimize())}>
        <span className="window-minimize" aria-hidden="true" />
      </button>
      <button type="button" aria-label={maximized ? '还原窗口' : '最大化窗口'} title={maximized ? '还原' : '最大化'}
        onClick={() => action(() => windowHandle.toggleMaximize())}>
        <span className={maximized ? 'window-restore' : 'window-maximize'} aria-hidden="true" />
      </button>
      <button type="button" className="window-close" aria-label="关闭窗口" title="关闭" onClick={() => action(() => windowHandle.close())}>
        <span aria-hidden="true">×</span>
      </button>
    </div>
    {problem && <small className="window-action-error" role="alert">{problem}</small>}
  </header>;
}
