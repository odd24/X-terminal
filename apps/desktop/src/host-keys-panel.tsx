import { useEffect, useState } from 'react';
import { config, type HostKeySummary } from './config-api';
const identity = (key: HostKeySummary) => JSON.stringify([key.endpoint.protocol, key.endpoint.host, key.endpoint.port, key.algorithm, key.fingerprint]);
export function HostKeysPanel() {
  const [keys, setKeys] = useState<HostKeySummary[]>([]);
  const [selected, setSelected] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('正在读取主机密钥');
  const current = keys.find(key => identity(key) === selected);
  async function readKeys() {
    const all: HostKeySummary[] = []; let revision: string | null = null; let offset = 0;
    for (;;) {
      const reply = await config({ op: 'host_keys_page', revision, offset });
      if (reply.result !== 'host_keys_page') throw new Error('主机密钥响应不匹配。');
      all.push(...reply.keys); revision = reply.revision;
      if (reply.next_offset === null) break;
      offset = reply.next_offset;
    }
    return all;
  }
  function apply(all: HostKeySummary[]) { setKeys(all); setSelected(previous => all.some(key => identity(key) === previous) ? previous : all[0] ? identity(all[0]) : ''); setConfirmed(false); }
  useEffect(() => {
    let disposed = false;
    void readKeys().then(all => { if (!disposed) { apply(all); setMessage('主机密钥已加载'); } })
      .catch(error => { if (!disposed) setMessage(error instanceof Error ? error.message : '主机密钥读取失败。'); })
      .finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, []);
  async function refresh() { setBusy(true); setMessage('正在读取主机密钥'); try { apply(await readKeys()); setMessage('主机密钥已加载'); } catch (error) { setMessage(error instanceof Error ? error.message : '读取失败。'); } finally { setBusy(false); } }
  async function forget() {
    if (!current || !confirmed) return;
    setBusy(true); setMessage('正在核对并移除主机密钥');
    try { await config({ op: 'forget_host_key', endpoint: current.endpoint, algorithm: current.algorithm, expected_fingerprint: current.fingerprint }); apply(await readKeys()); setMessage('主机密钥记录已移除；后续连接需要重新确认。'); }
    catch (error) { setConfirmed(false); setMessage(error instanceof Error ? error.message : '移除失败，未自动重试。'); }
    finally { setBusy(false); }
  }
  return <fieldset className="host-keys" disabled={busy}>
    <legend>主机密钥信任记录</legend>
    <p>只管理已保存的公开主机密钥。真实连接的首次/变化确认将在 SSH 接入中提供；移除记录不会中断已有连接。</p>
    <div aria-label="主机密钥状态" role="status">{message}</div>
    <label>已保存主机密钥<select aria-label="已保存主机密钥" value={selected} onChange={event => { setSelected(event.target.value); setConfirmed(false); }}>
      {!keys.length && <option value="">尚无主机密钥记录</option>}
      {keys.map(key => <option key={identity(key)} value={identity(key)}>{key.endpoint.protocol.toUpperCase()} · {key.endpoint.host}:{key.endpoint.port} · {key.algorithm}</option>)}
    </select></label>
    {current && <p>当前指纹：<code className="fingerprint">{current.fingerprint}</code></p>}
    <label className="check"><input aria-label="确认移除主机密钥" type="checkbox" disabled={!current} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />确认移除上方指纹对应的记录</label>
    <div className="config-actions"><button type="button" disabled={!current || !confirmed} onClick={() => void forget()}>移除选中主机密钥</button><button type="button" onClick={() => void refresh()}>刷新主机密钥</button></div>
  </fieldset>;
}
