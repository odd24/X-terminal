import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Panel, Field, ErrorNotice } from './ui';
import type { Profile, Settings } from './config-api';
import { disconnectSsh1, reference, ssh, SshRequestError, type Challenge, type ConnectionRef, type SshReply, type SshStatus } from './ssh-api';

export type Ssh1Intent = {
  profile: Profile & { settings: Extract<Settings, { protocol: 'ssh1' }> };
  revision: string;
  request_id: string;
  owner: string;
};

const knownStartErrors = new Set(['InvalidArgument', 'PermissionDenied', 'CapacityExceeded', 'Unsupported', 'INVALID_SSH_REQUEST']);
const failures: Record<string, string> = {
  HOST_KEY_REJECTED: '已拒绝 SSH1 主机指纹，本次未提交密码。',
  HOST_KEY_CONFLICT: '主机信任记录已变化，请重新打开连接并核对指纹。',
  CONFIGURATION: '配对的 SSH1 helper 不可用，请检查本机预览构建。',
  AUTHENTICATION_REJECTED: '服务器未接受本次密码。',
  APPROVAL_TIMEOUT: '本次确认超时，请重新打开该保存配置。',
  TRANSPORT_TIMEOUT: 'SSH1 连接超时。',
};

export function Ssh1Connect({ intent, ownerMatches, size, connected, close }: {
  intent: Ssh1Intent;
  ownerMatches(): boolean;
  size(): { cols: number; rows: number };
  connected(connection: ConnectionRef): void;
  close(): void;
}) {
  const { host, port, username, encoding } = intent.profile.settings;
  const [allowed, setAllowed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [target, setTarget] = useState<ConnectionRef>();
  const [status, setStatus] = useState<SshStatus>();
  const [verified, setVerified] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [error, setError] = useState('');
  const password = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  const attempted = useRef(false);
  const flight = useRef(false);
  const accepted = useRef<ConnectionRef | undefined>(undefined);
  const latest = useRef<SshStatus | undefined>(undefined);
  const handedOff = useRef(false);
  const retired = useRef(false);
  const scope = { profile_id: intent.profile.id, revision: intent.revision, request_id: intent.request_id };

  function retire(ref: ConnectionRef) {
    if (retired.current || !ownerMatches()) return;
    retired.current = true;
    void disconnectSsh1(ref).catch(() => {});
  }
  function accept(reply: SshReply) {
    if (reply.result !== 'connect_receipt'
      || reply.profile_id !== scope.profile_id || reply.revision !== scope.revision
      || reply.request_id !== scope.request_id || reply.connection.protocol !== 'SSH1'
      || !reply.connection.connection_id || !Number.isSafeInteger(reply.connection.generation)
      || reply.connection.generation < 1 || !ownerMatches()) throw new Error('invalid SSH1 receipt');
    const ref = reference(reply.connection);
    accepted.current = ref;
    if (live.current) {
      setTarget(ref);
      setUnknown(false);
    } else {
      retire(ref);
    }
  }
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (handedOff.current || !ownerMatches()) return;
      if (accepted.current) retire(accepted.current);
      else if (attempted.current) void ssh({ op: 'connect_status', ...scope }).then(accept).catch(() => {});
    };
  }, []);

  async function start(query: boolean) {
    if (!ownerMatches() || flight.current || (query ? !unknown : (!allowed || attempted.current))) return;
    if (!query) attempted.current = true;
    flight.current = true;
    setStarting(true);
    setError('');
    try {
      accept(await ssh(query ? { op: 'connect_status', ...scope } : { op: 'start_fixed', ...scope, ...size() }));
    } catch (reason) {
      if (!live.current || !ownerMatches()) return;
      const known = !query && reason instanceof SshRequestError && knownStartErrors.has(reason.code);
      setUnknown(!known);
      setError(known
        ? '未接受本次 SSH1 启动。请关闭窗口，刷新会话树并核对预览与配置版本。'
        : '连接结果不明。只查询原编号，未再次创建连接。');
    } finally {
      flight.current = false;
      if (live.current) setStarting(false);
    }
  }

  useEffect(() => {
    if (!target) return;
    let disposed = false, timer = 0;
    async function poll(ref: ConnectionRef) {
      try {
        const reply = await ssh({ op: 'status', connection: ref });
        if (disposed || !ownerMatches()) return;
        if (reply.result !== 'status' || reply.profile_id !== scope.profile_id
          || reply.connection.protocol !== 'SSH1' || reply.connection.connection_id !== ref.connection_id
          || reply.connection.generation !== ref.generation) throw new Error('invalid SSH1 status');
        latest.current = reply;
        setStatus(reply);
        if (reply.connection.state === 'CONNECTED') {
          handedOff.current = true;
          connected(ref);
          return;
        }
        if (['FAILED', 'DISCONNECTED'].includes(reply.connection.state)) return;
      } catch {
        if (!disposed && ownerMatches()) setError('SSH1 状态暂不可用，未重新提交审批。');
      }
      if (!disposed && ownerMatches()) timer = window.setTimeout(() => void poll(ref), 200);
    }
    void poll(target);
    return () => { disposed = true; clearTimeout(timer); };
  }, [target]);

  const challenge = status?.challenge;
  const candidate = challenge?.kind === 'host_key' ? challenge.review.candidate : undefined;
  const validHost = candidate?.endpoint.protocol === 'ssh1'
    && candidate.endpoint.host.toLowerCase() === host.toLowerCase()
    && candidate.endpoint.port === port && candidate.algorithm === 'rsa1'
    && /^SHA256:[A-Za-z0-9+/]{43}$/.test(candidate.fingerprint);
  const waitingPassword = challenge?.kind === 'credentials' && challenge.auth === 'password' && !challenge.stored_available;
  useEffect(() => { if (waitingPassword) password.current?.focus(); }, [waitingPassword, challenge?.id]);

  async function replyTo(challenge: Challenge, approval?: boolean, value?: string) {
    if (!target || !ownerMatches() || flight.current || submitted === challenge.id || latest.current?.challenge?.id !== challenge.id) return;
    flight.current = true;
    setSubmitted(challenge.id);
    setError('');
    try {
      const request = { connection: target, challenge_id: challenge.id };
      const reply = approval !== undefined
        ? await ssh({ op: 'answer_host', ...request, approve: approval })
        : await ssh({ op: 'authenticate', ...request, use_saved: false, password: value ?? '' });
      if (reply.result !== 'accepted') throw new Error('invalid approval reply');
    } catch {
      if (live.current && ownerMatches()) setError('审批结果未确认。请查看当前连接，未重复提交。');
    } finally { flight.current = false; }
  }
  function sendPassword(event: FormEvent) {
    event.preventDefault();
    const field = password.current;
    if (!waitingPassword || !challenge || !field) return;
    const value = field.value;
    field.value = '';
    if (value.includes('\0') || new TextEncoder().encode(value).length > 8192) {
      setError('本次密码超过 8 KiB 或含无效字符。');
      return;
    }
    void replyTo(challenge, undefined, value);
  }

  const failure = status?.failure;
  return <Panel title="连接 SSH1 保存配置" close={close} closeLabel="关闭 SSH1 连接窗口">
    <p><strong>{intent.profile.name}</strong> · {username}@{host}:{port} · {encoding}</p>
    <p className="config-notice">SSH1 是可能不安全的旧协议。请仅用于明确需要 SSH1 的端点。</p>
    {!target && <>
      <label className="check"><input type="checkbox" aria-label="本次允许使用 SSH1" checked={allowed} disabled={attempted.current} onChange={event => setAllowed(event.target.checked)} />本次明确选择 SSH1</label>
      {unknown
        ? <button disabled={starting} onClick={() => void start(true)}>仅查询原 SSH1 编号</button>
        : <button disabled={!allowed || starting || attempted.current} onClick={() => void start(false)}>连接此 SSH1 配置</button>}
    </>}
    {target && <p aria-label="SSH1 连接身份">{target.connection_id} · 代次 {target.generation} · {status?.connection.state ?? '正在连接'}</p>}
    {challenge?.kind === 'host_key' && validHost && <fieldset disabled={submitted === challenge.id}>
      <legend>核对 SSH1 主机</legend>
      <p>{challenge.review.status === 'changed' ? '保存的 SSH1 主机指纹已变化。' : '此 SSH1 主机尚未受信任。'}</p>
      <code className="fingerprint">{candidate.fingerprint}</code>
      <label className="check"><input aria-label="已核对 SSH1 主机指纹" type="checkbox" checked={verified === challenge.id} onChange={event => setVerified(event.target.checked ? challenge.id : '')} />已通过可信渠道核对完整指纹</label>
      <div className="config-actions"><button disabled={verified !== challenge.id} onClick={() => void replyTo(challenge, true)}>信任 SSH1 主机并继续</button><button onClick={() => void replyTo(challenge, false)}>拒绝 SSH1 主机</button></div>
    </fieldset>}
    {waitingPassword && <form onSubmit={sendPassword}>
      <Field label="临时密码"><input ref={password} aria-label="SSH1 登录密码" autoComplete="off" type="password" maxLength={8192} disabled={submitted === challenge.id} /></Field>
      <button type="submit" disabled={submitted === challenge.id}>提交本次 SSH1 密码</button>
    </form>}
    {challenge && !validHost && !waitingPassword && <ErrorNotice>SSH1 审批与原目标不匹配，审批已禁用。</ErrorNotice>}
    {(error || failure) && <ErrorNotice>{failure ? failures[failure] ?? 'SSH1 会话未完成，请核对本次目标。' : error}</ErrorNotice>}
  </Panel>;
}
