import { useEffect, useRef, useState } from 'react';
import { ssh, reference, type Connection, type ConnectionRef, type TaskStatus } from './ssh-api';
import { OutputDecoder } from './output-decoder';
import { requestId } from './request-id';
const same = (left: ConnectionRef, right?: ConnectionRef) => left.connection_id === right?.connection_id && left.generation === right.generation;

export function ExecPanel({ connection, open }: { connection?: Connection; open: boolean }) {
  const [command, setCommand] = useState('');
  const [timeout, setTimeoutMs] = useState(30000);
  const [limit, setLimit] = useState(1048576);
  const [tasks, setTasks] = useState<TaskStatus[]>([]);
  const [selected, setSelected] = useState('');
  const [lookup, setLookup] = useState('');
  const [task, setTask] = useState<TaskStatus>();
  const [output, setOutput] = useState<{ stderr: boolean; text: string }[]>([]);
  const [replacement, setReplacement] = useState(false);
  const [gap, setGap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('任务使用当前 SSH2 连接的独立 exec 通道；不会继承交互终端的目录或环境。');
  const mounted = useRef(true);
  const current = useRef(connection); current.current = connection;
  const currentTask = tasks.find(item => item.task_id === selected && connection && same(item.connection, connection));
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    setCommand(''); setLookup('');
    setSelected(tasks.find(item => same(item.connection, connection))?.task_id ?? '');
  }, [connection?.connection_id, connection?.generation]);
  useEffect(() => {
    setTask(undefined); setOutput([]); setGap(false); setReplacement(false);
    if (!currentTask) return;
    const target = currentTask;
    let disposed = false; let timer = 0; let cursor = 1;
    let chunks: { stderr: boolean; text: string }[] = [];
    let length = 0;
    let decoders = [new OutputDecoder(target.encoding), new OutputDecoder(target.encoding)];
    const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });
    function decode(stderr: boolean, result: { bytes: Uint8Array; replacement: boolean }) {
      if (result.replacement) setReplacement(true);
      append(stderr, utf8.decode(result.bytes));
    }
    function append(stderr: boolean, text: string) {
      if (!text) return;
      chunks.push({ stderr, text }); length += text.length;
      while (length > 65536 || chunks.length > 128) { length -= chunks.shift()!.text.length; setGap(true); }
    }
    async function poll() {
      try {
        const status = await ssh({ op: 'exec_status', connection: target.connection, task_id: target.task_id });
        if (disposed) return;
        if (status.result !== 'exec' || status.task_id !== target.task_id || !same(status.connection, target.connection) || status.encoding !== target.encoding) throw new Error('任务状态响应不匹配。');
        setTask(status);
        setTasks(values => values.map(item => item.task_id === status.task_id && same(item.connection, status.connection) ? status : item));
        const page = await ssh({ op: 'exec_read', connection: target.connection, task_id: target.task_id, cursor, max_bytes: 65536 });
        if (disposed) return;
        if (page.result !== 'exec_output' || page.task_id !== target.task_id || !same(page.connection, target.connection)) throw new Error('任务输出响应不匹配。');
        if (page.output.truncated) { setGap(true); decoders = [new OutputDecoder(target.encoding), new OutputDecoder(target.encoding)]; }
        for (const event of page.output.events) decode(event.stderr, decoders[Number(event.stderr)].decode(new Uint8Array(event.bytes)));
        cursor = page.output.next_cursor;
        if (page.output.completed && status.phase === 'FINISHED' && page.output.events.length === 0) {
          decoders.forEach((decoder, index) => decode(Boolean(index), decoder.finish()));
          setOutput([...chunks]); return;
        }
        setOutput([...chunks]);
        timer = window.setTimeout(() => void poll(), 150);
      } catch (error) { if (!disposed) setMessage((error as Error).message); }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [currentTask?.task_id, currentTask?.connection.connection_id, currentTask?.connection.generation]);
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await action(); }
    catch (error) { if (mounted.current) setMessage((error as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  }
  function target() {
    if (!connection || connection.protocol !== 'SSH2' || !same(connection, current.current)) throw new Error('请选择当前 SSH2 连接。');
    return reference(connection);
  }
  function retain(reply: TaskStatus) {
    setTasks(values => values.some(item => item.task_id === reply.task_id && same(item.connection, reply.connection)) ? values.map(item => item.task_id === reply.task_id && same(item.connection, reply.connection) ? reply : item) : [...values.slice(-63), reply]);
    if (same(reply.connection, current.current)) setSelected(reply.task_id);
  }
  if (!open) return null;
  return <section className="config-panel exec-panel" aria-label="SSH2 exec 任务">
    <h2>独立 exec 任务</h2>
    <p role="status">{message}</p>
    <small>当前选择：{connection?.connection_id ?? '尚无连接'} · 代次 {connection?.generation ?? '—'}。切换连接或关闭面板不会取消任务；重载会清除本页列表，可记录任务 ID 后查询。本页保留最近 64 项；服务最多保留每连接 16 项、全局 64 项结果，容量需要时回收已结束的有序任务，过期结果无法再查询且不会重跑。重连不迁移。</small>
    <form onSubmit={event => { event.preventDefault(); const text = command; if (/[\uD800-\uDFFF]/u.test(text)) { setMessage('命令包含不完整 Unicode 字符，未发送。'); return; } setCommand(''); void act(async () => {
      const reply = await ssh({ op: 'exec', connection: target(), request_id: requestId(), command: text, timeout_ms: timeout, max_output_bytes: limit });
      if (reply.result !== 'exec') throw new Error('任务启动响应不匹配。');
      if (mounted.current) { retain(reply); setMessage('任务已提交；取消或断线不能保证撤销远端动作。'); }
    }); }}>
      <label>命令<textarea aria-label="exec 命令" spellCheck={false} autoComplete="off" maxLength={65536} value={command} onChange={event => setCommand(event.target.value)} /></label>
      <div className="form-grid"><label>超时（毫秒）<input aria-label="exec 超时毫秒" type="number" min="1" max="86400000" value={timeout} onChange={event => setTimeoutMs(Number(event.target.value))} /></label><label>总输出上限（字节）<input aria-label="exec 输出上限" type="number" min="1" max="1048576" value={limit} onChange={event => setLimit(Number(event.target.value))} /></label></div>
      <button disabled={busy || connection?.protocol !== 'SSH2' || connection.state !== 'CONNECTED' || !command.length} type="submit">启动 exec 任务</button>
    </form>
    <label>本页任务<select aria-label="exec 任务列表" value={selected} onChange={event => setSelected(event.target.value)}><option value="">请选择任务</option>{tasks.filter(item => same(item.connection, connection)).map(item => <option key={item.task_id} value={item.task_id}>{item.task_id} · {item.phase}</option>)}</select></label>
    <div className="form-grid"><label>任务 ID<input aria-label="查询 exec 任务 ID" value={lookup} onChange={event => setLookup(event.target.value)} maxLength={36} /></label><div className="config-actions"><button disabled={busy || connection?.protocol !== 'SSH2'} onClick={() => void act(async () => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lookup)) throw new Error('请输入完整 UUID 任务 ID。');
      const reply = await ssh({ op: 'exec_status', connection: target(), task_id: lookup });
      if (reply.result !== 'exec') throw new Error('任务查询响应不匹配。');
      if (mounted.current) retain(reply);
    })}>查询 exec 任务</button></div></div>
    {task && <>
      <p aria-label="exec 任务状态">{task.task_id} · {task.phase}{task.summary && ` · ${task.summary.end} · 退出码 ${task.summary.exit_status ?? '未提供'} · 信号 ${task.summary.exit_signal ?? '无'} · 请求确认 ${task.summary.request_accepted === null ? '未知' : task.summary.request_accepted ? '已观察到接受' : '未观察到接受'}`}</p>
      {task.summary && <p>stdout {task.summary.stdout_bytes} 字节 · stderr {task.summary.stderr_bytes} 字节{task.summary.output_truncated && ' · 捕获达到总输出上限，输出不完整'}</p>}
      <button disabled={busy || task.phase === 'FINISHED' || !same(task.connection, connection)} onClick={() => void act(async () => { await ssh({ op: 'exec_cancel', connection: task.connection, task_id: task.task_id }); if (mounted.current) setMessage('已请求取消；远端已发生的动作不会因此撤销。'); })}>取消选中 exec 任务</button>
    </>}
    {gap && <p role="alert">输出缺口：服务或页面保留缓冲已覆盖较早数据；当前视图不完整。</p>}
    {replacement && <p role="alert">输出包含替换字符 U+FFFD，可能来自原文或不完整/无效编码；原始字节保持不变。</p>}
    <small>输出流：stdout 使用浅色，stderr 使用橙色；当前按任务编码 {task?.encoding ?? currentTask?.encoding ?? '待查询'} 显示。</small>
    <pre aria-label="exec 输出">{output.map((chunk, index) => <span key={index} className={chunk.stderr ? 'exec-stderr' : 'exec-stdout'} data-stream={chunk.stderr ? 'stderr' : 'stdout'}>{chunk.text}</span>)}</pre>
  </section>;
}
