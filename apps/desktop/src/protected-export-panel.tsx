import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { sameConnection, uuid, type Scope } from './agent-management';
import { LogSavePanel } from './log-save-panel';
import { checkedRedaction, type Redaction } from './output-protection';
import { OutputProtectionEditor, OutputProtectionPreview } from './output-protection-editor';
import { requestId } from './request-id';
import type { Connection, ConnectionRef } from './ssh-api';
import { Field } from './ui';

type Source = {
  connection: ConnectionRef;
  protocol: 'SSH2' | 'SERIAL';
  from_cursor: number;
  through_cursor: number;
  encoding: string;
  rows: number;
  cols: number;
};
export type ExportProposal = {
  operation: {
    protocol: 'EXPORT';
    request: { service_id: string; request_id: string; retained_ended_output: Source; format: 'protected_utf8' };
  };
  scopes: Scope[];
  lifetime_ms: number;
  redaction: Redaction;
};

export function ProtectedExportGrantPanel({ serviceId, target, disabled, submit }: {
  serviceId: string;
  target: Connection;
  disabled: boolean;
  submit(proposal: ExportProposal, current: () => boolean): Promise<void>;
}) {
  const [rules, setRules] = useState<Redaction>({ sensitive_fields: true, literals: [] });
  const [seconds, setSeconds] = useState(120);
  const [proposal, setProposal] = useState<ExportProposal>();
  const [consent, setConsent] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const busy = useRef(false);
  const invalidate = () => { ++revision.current; setConsent(false); setProposal(undefined); };
  useEffect(() => () => { ++revision.current; }, []);

  async function preview() {
    if (busy.current || disabled) return;
    busy.current = true;
    invalidate();
    const stamp = revision.current;
    setPreparing(true);
    setError('');
    try {
      if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 1800) throw new Error('请输入 1–1800 秒期限');
      const redaction = checkedRedaction(rules);
      const connection = { connection_id: target.connection_id, generation: target.generation };
      const reply = await invoke<{ type: string; data: Source }>('protected_export_desktop_request', {
        request: { op: 'prepare', service_id: serviceId, connection },
      });
      if (revision.current !== stamp) return;
      const source = reply.data;
      if (reply.type !== 'prepared' || !source || !source.connection || !sameConnection(source.connection, connection)
        || source.protocol !== target.protocol || !['SSH2', 'SERIAL'].includes(source.protocol)
        || ![source.from_cursor, source.through_cursor, source.rows, source.cols].every(n => Number.isSafeInteger(n) && n > 0)
        || source.through_cursor <= source.from_cursor || source.through_cursor - source.from_cursor > 128
        || typeof source.encoding !== 'string' || !source.encoding || source.encoding.length > 64) throw new Error('源范围与当前已结束代次不匹配');
      const { protocol, from_cursor, through_cursor, encoding, rows, cols } = source;
      setProposal({
        operation: {
          protocol: 'EXPORT',
          request: {
            service_id: serviceId,
            request_id: requestId(),
            retained_ended_output: { connection, protocol, from_cursor, through_cursor, encoding, rows, cols },
            format: 'protected_utf8',
          },
        },
        scopes: [{ target: { kind: 'connection', connection }, action: 'EXPORT' }],
        lifetime_ms: seconds * 1000,
        redaction,
      });
    } catch (e) {
      if (revision.current === stamp) setError(`无法预览保护文本导出（${String(e)}）`);
    } finally {
      busy.current = false;
      setPreparing(false);
    }
  }

  async function approve() {
    if (!proposal || !consent || busy.current || disabled) return;
    busy.current = true;
    const stamp = revision.current;
    setConsent(false);
    try {
      await submit(proposal, () => revision.current === stamp);
    } finally {
      busy.current = false;
      if (revision.current === stamp) invalidate();
    }
  }

  const source = proposal?.operation.request.retained_ended_output;
  return <fieldset disabled={disabled || preparing} aria-label="保护文本导出授权">
    <legend>已结束会话的保护文本导出</legend>
    <p>只生成本代次仍保留的保护文本副本。内部缺口或范围变化会拒绝导出。原始输出、录制日志与用户文件保持各自的存储方式。</p>
    <OutputProtectionEditor required value={rules} change={value => { if (value) { invalidate(); setRules(value); } }} />
    <Field label="导出授权期限（秒）"><input type="number" min={1} max={1800} value={seconds} onChange={event => { invalidate(); setSeconds(Number(event.target.value)); }} /></Field>
    <button onClick={() => void preview()}>预览保护文本导出</button>
    {error && <p role="alert">{error}</p>}
    {proposal && source && <fieldset aria-label="保护文本导出预览">
      <legend>核对本次范围</legend>
      <p>{serviceId} · {source.protocol} · {source.connection.connection_id} / {source.connection.generation}</p>
      <p>保留输出 [{source.from_cursor}, {source.through_cursor}) · {source.encoding} · {source.cols} × {source.rows} · UTF-8 文本 · {proposal.lifetime_ms / 1000} 秒</p>
      <p>原操作编号 {proposal.operation.request.request_id}。批准后仍需绑定原票据，另存由用户发起。</p>
      {source.from_cursor > 1 && <p>较早的输出已超出保留范围，截断边界会按保护策略处理。</p>}
      <OutputProtectionPreview value={proposal.redaction} />
      <label className="check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我已核对固定范围和保护规则</label>
      <button disabled={!consent} onClick={() => void approve()}>批准单次保护文本导出</button>
    </fieldset>}
  </fieldset>;
}

export function ProtectedExportHandoff({ approved }: { approved: ExportProposal['operation']['request'] }) {
  const [artifact, setArtifact] = useState('');
  return <fieldset aria-label="保护文本导出交接">
    <legend>保护文本导出交接</legend>
    <Field label="批准的 logs_export 参数"><textarea readOnly rows={7} value={JSON.stringify(approved, null, 2)} onFocus={event => event.target.select()} /></Field>
    <Field label="已完成产物 ID"><input maxLength={36} value={artifact} onChange={event => setArtifact(event.target.value.trim().toLowerCase())} /></Field>
    {uuid(artifact) && <LogSavePanel key={artifact} mode="PROTECTED" serviceId={approved.service_id} source={{
      mode: 'PROTECTED', phase: 'COMPLETED', log_id: artifact,
      request_id: approved.request_id, connection: approved.retained_ended_output.connection,
    }} />}
  </fieldset>;
}
