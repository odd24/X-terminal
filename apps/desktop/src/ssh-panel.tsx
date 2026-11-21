import { useEffect, useMemo, useRef, useState } from 'react';
import { readConfiguration, type Profile } from './config-api';
import { ssh, reference, SshRequestError, type Connection, type ConnectionRef, type SshStatus } from './ssh-api';
import { requestId } from './request-id';
import { ControlIcon, IconButton, PanelHeading, ToolbarMenu } from './ui';

type Operation = { id: string; label: string; origin?: ConnectionRef } & (
  { kind: 'start'; profile: string } | { kind: 'disconnect' | 'reconnect' | 'forget'; target: ConnectionRef }
);
const operationNames = { start: '连接', disconnect: '断开连接', reconnect: '重新连接', forget: '移除连接记录' };
const stateNames: Record<string, string> = {
  CONNECTING: '正在连接', AUTHENTICATING: '正在认证', CONNECTED: '已连接',
  CLOSING: '正在断开', DISCONNECTED: '已断开', FAILED: '连接失败',
};
const ended = (state: string) => state === 'DISCONNECTED' || state === 'FAILED';
const same = (a?: ConnectionRef, b?: ConnectionRef) => a?.connection_id === b?.connection_id && a?.generation === b?.generation;

function runRequest(operation: Operation, query: boolean, size: () => { cols: number; rows: number }) {
  const request_id = operation.id;
  if (operation.kind === 'start') {
    return ssh(query ? { op: 'start_status', request_id } : { op: 'start', profile_id: operation.profile, request_id, ...size() });
  }
  const connection = operation.target;
  switch (operation.kind) {
    case 'reconnect': return ssh(query ? { op: 'reconnect_status', connection, request_id } : { op: 'reconnect', connection, request_id, ...size() });
    case 'disconnect': return ssh({ op: query ? 'disconnect_status' : 'disconnect', connection, request_id });
    case 'forget': return ssh({ op: query ? 'forget_status' : 'forget_start', connection, request_id });
  }
}

function endpoint(status: SshStatus) {
  const settings = status.source_settings ?? status.temporary_settings;
  const host = status.server_host;
  if (settings?.protocol !== 'ssh2') return host;
  return `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${settings.port}`;
}

export function SshPanel({ open, connection, requested, select, size, closePanel }: {
  open: boolean; connection?: Connection; requested: string; select(id: string, expected?: ConnectionRef): void;
  size(): { cols: number; rows: number }; closePanel(): void;
}) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [latest, setStatus] = useState<SshStatus>();
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');
  const [profileProblem, setProfileProblem] = useState('');
  const [statusProblem, setStatusProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState<Operation>();
  const [confirm, setConfirm] = useState<ConnectionRef>();
  const [disconnecting, setDisconnecting] = useState<ConnectionRef>();
  const [approved, setApproved] = useState(false);
  const [password, setPassword] = useState('');
  const [answers, setAnswers] = useState<string[]>([]);
  const mounted = useRef(true);
  const flight = useRef(false);
  const reloadFlight = useRef(false);
  const actionMenu = useRef<HTMLElement>(null);
  const current = useRef(connection); current.current = connection;
  const scope = useMemo(() => ({}), [open, requested]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const status = latest && same(latest.connection, connection) ? latest : undefined;
  const challenge = status?.challenge;
  const profile = profiles.find(item => item.id === profileId);
  async function reload() {
    if (reloadFlight.current) return;
    reloadFlight.current = true;
    setRefreshing(true);
    try {
      const result = await readConfiguration();
      if (!mounted.current) return;
      const saved = result.profiles.filter(item => item.settings.protocol === 'ssh2');
      setProfiles(saved);
      setProfileId(id => saved.some(item => item.id === id) ? id : saved[0]?.id ?? '');
      setProfileProblem('');
    } catch (error) {
      if (mounted.current) setProfileProblem((error as Error).message);
    } finally {
      reloadFlight.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (open) void reload(); }, [open]);
  useEffect(() => {
    setStatus(undefined); setStatusProblem(''); setPassword(''); setAnswers([]); setApproved(false); setConfirm(undefined);
    if (!open || connection?.protocol !== 'SSH2') return;
    let disposed = false; let timer = 0;
    const target = reference(connection);
    async function poll() {
      try {
        const reply = await ssh({ op: 'status', connection: target });
        if (disposed) return;
        if (reply.result !== 'status' || !same(reply.connection, target)) throw new Error('SSH 状态响应不匹配。');
        setStatus(reply);
        setStatusProblem('');
        if (ended(reply.connection.state)) setDisconnecting(previous => same(previous, target) ? undefined : previous);
      } catch (error) {
        if (!disposed) { setStatus(undefined); setStatusProblem((error as Error).message); }
      }
      if (!disposed) timer = window.setTimeout(() => void poll(), 250);
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [open, connection?.connection_id, connection?.generation, connection?.protocol]);
  useEffect(() => { setPassword(''); setAnswers([]); setApproved(false); }, [challenge?.id]);
  async function act(action: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setProblem('');
    try { await action(); }
    catch (error) { if (mounted.current) setProblem((error as Error).message); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  function active() {
    if (!status || status.connection.connection_id !== current.current?.connection_id || status.connection.generation !== current.current?.generation) throw new Error('连接已切换，请等待状态刷新。');
    return reference(status.connection);
  }
  async function run(operation: Operation, query: boolean) {
    const request_id = operation.id;
    const kind = operation.kind;
    const originScope = currentScope.current;
    const followsCurrent = () => open && originScope === currentScope.current && (
      same(current.current, operation.origin)
      || (kind !== 'start' && !current.current && requested === operation.target.connection_id)
    );
    setMessage('');
    try {
      const reply = await runRequest(operation, query, size);
      if (!mounted.current) return;
      if (kind === 'start' || kind === 'reconnect') {
        const linked = kind === 'reconnect' && query
          ? reply.result === 'reconnect_receipt' && reply.request_id === request_id && same(reply.previous, operation.target)
          : reply.result === 'started';
        if (!linked || (reply.result !== 'started' && reply.result !== 'reconnect_receipt') || reply.connection.protocol !== 'SSH2') throw new Error('SSH 建连响应不匹配。');
        if (kind === 'reconnect' && (reply.connection.connection_id !== operation.target.connection_id
          || reply.connection.generation !== operation.target.generation + 1)) throw new Error('SSH 重连代次不匹配。');
        if (followsCurrent()) select(reply.connection.connection_id, reply.connection);
        else if (!same(current.current, reply.connection)) setMessage(`${operation.label} · 已提交连接请求，可在会话标签查看进度。`);
      } else if (kind === 'disconnect' && reply.result === 'disconnect' && same(reply.connection, operation.target) && reply.request_id === request_id) {
        if (reply.state === 'REQUESTED') {
          setDisconnecting(operation.target);
          setPending(undefined);
          return;
        }
        if (reply.state !== 'TRANSPORT_ENDED') throw new Error('SSH 断开回执不匹配。');
        setDisconnecting(undefined);
        setMessage(`${operation.label} · 本地 SSH 连接已关闭。`);
      } else if (kind === 'forget' && reply.result === 'forget' && reply.state === 'REMOVED' && same(reply.connection, operation.target) && reply.request_id === request_id) {
        if (followsCurrent()) { setStatus(undefined); select(''); }
        setMessage(`${operation.label} · 连接记录及保留输出、回执和任务已移除。保存的配置、凭据和日志文件仍可使用。`);
      } else {
        throw new Error('SSH 操作回执不匹配。');
      }
      setPending(undefined);
    } catch (error) {
      if (!mounted.current) return;
      const rejected = !query && error instanceof SshRequestError
        && ['CapacityExceeded', 'StaleGeneration', 'InvalidState', 'InvalidArgument', 'INVALID_SSH_REQUEST', 'NotFound', 'PermissionDenied'].includes(error.code);
      setPending(rejected ? undefined : operation);
      setProblem(rejected ? (error as Error).message : `${operationNames[kind]}结果待核对。${(error as Error).message} 可查询原请求编号。`);
    }
  }
  const state = status && disconnecting && same(disconnecting, status.connection) && !ended(status.connection.state)
    ? 'CLOSING' : status?.connection.state ?? '';
  const blocked = busy || !!pending;
  function changeConnection(kind: 'disconnect' | 'reconnect' | 'forget') {
    if (!status) return;
    void act(async () => {
      const target = active();
      if (kind === 'forget' && !same(confirm, target)) return;
      setConfirm(undefined);
      setPassword(''); setAnswers([]);
      await run({ kind, target, id: requestId(), origin: target, label: endpoint(status) }, false);
    });
  }
  function cancelConfirm() { setConfirm(undefined); actionMenu.current?.focus(); }
  if (!open) return null;
  return <section className="config-panel ssh-panel" aria-label="SSH2 连接面板">
    <PanelHeading title="SSH 连接" close={closePanel} closeLabel="关闭 SSH2 工具" />
    <label htmlFor="saved-ssh-profile">已保存的配置</label>
    <div className="ssh-profile-row">
      <select id="saved-ssh-profile" aria-label="SSH2 配置" data-dialog-autofocus disabled={busy} value={profileId} onChange={event => setProfileId(event.target.value)}><option value="">请选择配置</option>{profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <IconButton icon="refresh" label="刷新 SSH2 配置" disabled={busy || refreshing} onClick={() => void reload()} />
      <button type="button" className="primary-action" aria-label="建立 SSH2 连接" disabled={blocked || refreshing || !!profileProblem || !profile} onClick={() => profile && void act(() => run({ kind: 'start', id: requestId(), profile: profile.id, origin: connection, label: profile.name }, false))}>连接</button>
    </div>
    {profileProblem && <p className="ssh-problem" role="alert">{profileProblem}</p>}
    <section className="ssh-current">
      <h3>当前会话</h3>
      <div className="ssh-summary" role="status" aria-label="SSH2 状态" data-state={state}>
        {status ? <><strong><span className="ssh-state-dot" aria-hidden="true" />{stateNames[state] ?? state}</strong><span>{endpoint(status)}</span></>
          : statusProblem ? '连接状态未知' : connection?.protocol === 'SSH2' ? '正在读取 SSH 连接状态…' : '未选中 SSH 会话'}
      </div>
    </section>
    {status && <>
      <div className="ssh-session-actions">
        <details key={`${status.connection.connection_id}:${status.connection.generation}`} className="ssh-connection-detail">
          <summary>连接详情</summary>
          <small aria-label="SSH2 目标">连接编号 {status.connection.connection_id} · 代次 {status.connection.generation}</small>
          <small>编码 {status.encoding}{status.shell_exit_status !== null && ` · shell 退出码 ${status.shell_exit_status}`}{status.shell_exit_signal && ` · 信号 ${status.shell_exit_signal}`}</small>
        </details>
        <div className="config-actions">
          {ended(state) ? <button type="button" disabled={blocked} onClick={() => changeConnection('reconnect')}>重新连接</button>
            : <button type="button" disabled={blocked || state === 'CLOSING'} onClick={() => changeConnection('disconnect')}>断开连接</button>}
          <ToolbarMenu className="ssh-session-menu" label="更多会话操作" summary={actionMenu} text={<ControlIcon icon="more" />}>
            <button type="button" disabled={blocked || !ended(state)} onClick={() => setConfirm(reference(status.connection))}>移除连接记录</button>
          </ToolbarMenu>
        </div>
      </div>
      {confirm && same(confirm, status.connection) && ended(state) && <fieldset className="ssh-forget" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelConfirm(); }
      }}>
        <legend>确认移除此连接记录</legend>
        <p>{endpoint(status)} · 代次 {confirm.generation}。保留输出、输入回执和任务结果将移除。配置、凭据和日志文件仍会保留。</p>
        <div className="config-actions"><button type="button" autoFocus onClick={cancelConfirm}>取消移除</button><button type="button" disabled={blocked} onClick={() => changeConnection('forget')}>确认移除连接记录</button></div>
      </fieldset>}
    </>}
    {(statusProblem || status?.failure) && <p className="ssh-problem" role="alert">{statusProblem || `连接失败 · ${status?.failure}`}</p>}
    {problem && <p className="ssh-problem" role="alert">{problem}</p>}
    {message && <p role="status">{message}</p>}
    {pending && <div className="ssh-receipt">
      <small>{operationNames[pending.kind]} · {pending.label}<br />原请求编号 <code>{pending.id}</code></small>
      <button type="button" disabled={busy} onClick={() => void act(() => run(pending, true))}>查询原请求</button>
    </div>}
    {status && <>
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
