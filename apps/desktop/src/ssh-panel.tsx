import { useEffect, useRef, useState } from 'react';
import { readConfiguration, type Profile } from './config-api';
import { ssh, reference, type Connection, type SshStatus } from './ssh-api';
import { requestId } from './request-id';

export function SshPanel({ connection, select, size }: { connection?: Connection; select(id: string): void; size(): { cols: number; rows: number } }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [status, setStatus] = useState<SshStatus>();
  const [message, setMessage] = useState('选择已保存的 SSH2 配置，手动建立连接。');
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [password, setPassword] = useState('');
  const [answers, setAnswers] = useState<string[]>([]);
  const mounted = useRef(true);
  const current = useRef(connection); current.current = connection;
  const challenge = status?.challenge;
  const profile = profiles.find(item => item.id === profileId);
  async function reload() {
    try { const result = await readConfiguration(); if (mounted.current) setProfiles(result.profiles.filter(item => item.settings.protocol === 'ssh2')); }
    catch (error) { if (mounted.current) setMessage((error as Error).message); }
  }
  useEffect(() => { mounted.current = true; void reload(); return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setStatus(undefined); setPassword(''); setAnswers([]); setApproved(false);
    if (connection?.protocol !== 'SSH2') return;
    let disposed = false; let timer = 0;
    const target = reference(connection);
    async function poll() {
      try {
        const reply = await ssh({ op: 'status', connection: target });
        if (disposed) return;
        if (reply.result !== 'status') throw new Error('SSH 状态响应不匹配。');
        setStatus(reply);
        timer = window.setTimeout(() => void poll(), 250);
      } catch (error) { if (!disposed) setMessage((error as Error).message); }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [connection?.connection_id, connection?.generation, connection?.protocol]);
  useEffect(() => { setPassword(''); setAnswers([]); setApproved(false); }, [challenge?.id]);
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await action(); }
    catch (error) { if (mounted.current) setMessage((error as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  }
  function active() {
    if (!status || status.connection.connection_id !== current.current?.connection_id || status.connection.generation !== current.current?.generation) throw new Error('连接已切换，请等待状态刷新。');
    return reference(status.connection);
  }
  async function start(reconnect = false) {
    const request_id = requestId();
    const reply = await ssh(reconnect
      ? { op: 'reconnect', connection: active(), request_id, ...size() }
      : { op: 'start', profile_id: profileId, request_id, ...size() });
    if (reply.result !== 'started') throw new Error('SSH 建连响应不匹配。');
    if (mounted.current) { select(reply.connection.connection_id); setMessage('已提交连接请求；请核对本连接的主机指纹与认证提示。'); }
  }
  return <section className="config-panel ssh-panel" aria-label="SSH2 连接面板">
    <div className="config-heading"><h2>SSH2 连接</h2><button disabled={busy} onClick={() => void reload()}>刷新 SSH2 配置</button></div>
    <div className="form-grid"><label>已保存的配置<select aria-label="SSH2 配置" value={profileId} onChange={event => setProfileId(event.target.value)}><option value="">请选择配置</option>{profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <div className="config-actions"><button disabled={busy || !profile} onClick={() => void act(() => start())}>建立 SSH2 连接</button></div></div>
    <small>终端按建立连接时的 UTF-8/GBK/GB18030 编码收发；编辑配置不改变活动连接。无法表示的文本整批拒绝，原始字节接口保持原样。密码不显示在输入诊断中。</small>
    <p role="status">{message}</p>
    {status && <>
      <small aria-label="SSH2 目标">连接：{status.connection.connection_id} · 代次 {status.connection.generation} · 编码 {status.encoding}</small>
      <p aria-label="SSH2 状态">{status.connection.state} · 代次 {status.connection.generation} · 编码 {status.encoding}{status.failure && ` · ${status.failure}`}{status.shell_exit_status !== null && ` · shell 退出码 ${status.shell_exit_status}`}{status.shell_exit_signal && ` · 信号 ${status.shell_exit_signal}`}</p>
      <div className="config-actions"><button disabled={busy || ['DISCONNECTED', 'FAILED'].includes(status.connection.state)} onClick={() => void act(async () => { await ssh({ op: 'close', connection: active() }); setPassword(''); setAnswers([]); setMessage('已请求关闭；已发送的远端动作不会因此撤销。'); })}>关闭 SSH2 连接</button>
        <button disabled={busy || !['DISCONNECTED', 'FAILED'].includes(status.connection.state)} onClick={() => void act(() => start(true))}>显式重连 SSH2</button>
        <button disabled={busy || !['DISCONNECTED', 'FAILED'].includes(status.connection.state)} onClick={() => void act(async () => {
          const target = active();
          const reply = await ssh({ op: 'forget', connection: target });
          if (reply.result !== 'accepted') throw new Error('移除连接响应不匹配。');
          if (mounted.current && current.current?.connection_id === target.connection_id && current.current.generation === target.generation) { setStatus(undefined); select(''); }
          if (mounted.current) setMessage('连接记录及保留输出/任务已移除；配置和凭据仍可使用。旧建连请求不会重新执行。');
        })}>移除连接记录</button></div>
      <small>服务最多保留 64 条连接。仅已断开或失败的连接可移除；移除会丢弃其保留输出、输入回执和任务结果。已发送的远端动作不会因此撤销。</small>
      {challenge && <fieldset key={challenge.id} disabled={busy}><legend>{challenge.kind === 'host_key' ? '确认主机身份' : '本次连接认证'}</legend>
        {challenge.kind === 'host_key' && <>
          <p>{challenge.review.status === 'changed' ? '主机密钥已变化。请通过可信渠道核对后再继续。' : '此主机尚需确认。请通过可信渠道核对指纹。'}</p>
          <p>{challenge.review.candidate.endpoint.host}:{challenge.review.candidate.endpoint.port} · {challenge.review.candidate.algorithm}<code className="fingerprint">{challenge.review.candidate.fingerprint}</code></p>
          {challenge.review.known.map(item => <p key={item.fingerprint}>原有 {item.algorithm}<code className="fingerprint">{item.fingerprint}</code></p>)}
          <label className="check"><input aria-label="已核对 SSH2 主机指纹" type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} />已通过可信渠道核对完整指纹</label>
          <div className="config-actions"><button disabled={!approved} onClick={() => void act(async () => { await ssh({ op: 'answer_host', connection: active(), challenge_id: challenge.id, approve: true }); setApproved(false); })}>信任本次 SSH2 主机</button><button onClick={() => void act(async () => { await ssh({ op: 'answer_host', connection: active(), challenge_id: challenge.id, approve: false }); })}>拒绝 SSH2 主机</button></div>
        </>}
        {challenge.kind === 'credentials' && <>
          <p>认证方式：{challenge.auth} · 保存凭据{challenge.stored_available ? '可用' : '不可用'}</p>
          {challenge.stored_available && <button onClick={() => void act(async () => { setPassword(''); await ssh({ op: 'authenticate', connection: active(), challenge_id: challenge.id, use_saved: true, password: null }); })}>使用保存的 SSH2 凭据</button>}
          {challenge.auth === 'password' && <form onSubmit={event => { event.preventDefault(); const secret = password; setPassword(''); void act(async () => { await ssh({ op: 'authenticate', connection: active(), challenge_id: challenge.id, use_saved: false, password: secret }); }); }}>
            <label>临时密码<input aria-label="SSH2 临时密码" type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} maxLength={65536} /></label><button type="submit">提交本次 SSH2 密码</button></form>}
          {challenge.auth === 'keyboard_interactive' && <button onClick={() => void act(async () => { await ssh({ op: 'authenticate', connection: active(), challenge_id: challenge.id, use_saved: true, password: null }); })}>开始交互式 SSH2 认证</button>}
          {challenge.auth === 'public_key' && !challenge.stored_available && <p>请在连接配置中导入私钥文件后重新连接。</p>}
        </>}
        {challenge.kind === 'interactive' && <form onSubmit={event => { event.preventDefault(); const values = challenge.prompts.map((_, index) => answers[index] ?? ''); setAnswers([]); void act(async () => { await ssh({ op: 'answer_interactive', connection: active(), challenge_id: challenge.id, answers: values }); }); }}>
          <p>{challenge.name}</p><p>{challenge.instructions}</p>
          {challenge.prompts.map((prompt, index) => <label key={index}>{prompt.text}<input aria-label={`SSH2 认证回答 ${index + 1}`} type={prompt.echo ? 'text' : 'password'} autoComplete="off" maxLength={8192} value={answers[index] ?? ''} onChange={event => setAnswers(values => { const next = [...values]; next[index] = event.target.value; return next; })} /></label>)}
          <button type="submit">提交 SSH2 认证回答</button>
        </form>}
      </fieldset>}
    </>}
  </section>;
}
