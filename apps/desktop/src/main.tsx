import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  return <main>
    <span className="eyebrow">共享终端 · 开发预览</span>
    <h1>你的连接，同一个会话。</h1>
    <p>SSH2、SSH1 与串口工作区正在构建。</p>
    <section aria-label="当前状态">
      <h2>尚无活动连接</h2>
      <p>桌面骨架已就绪。连接服务和终端能力尚未接入。</p>
    </section>
    <footer>本地运行 · 未连接设备 · P01 环境基线</footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
