import type { Profile } from './config-api';
import type { Connection } from './ssh-api';
import { uuid, checkedTask, sameTask, type Scope, type TaskContext } from './agent-management.ts';

export type ProfileProposal = { service_id: string; profile_id: string; revision: string; name: string; protocol: string; description: string; lifetime_ms: number; scopes: Scope[]; task?: TaskContext };
export function profileDescription(profile: Profile): string {
  const s = profile.settings;
  if (s.protocol === 'ssh2') return `${s.host}:${s.port} · 用户 ${s.username} · 认证 ${s.auth} · 编码 ${s.encoding} · 主机信任与凭据使用仍需Desktop批准`;
  if (s.protocol === 'serial') return `${s.port} · ${s.baud_rate} · ${s.data_bits}/${s.parity}/${s.stop_bits} · 流控 ${s.flow} · 编码 ${s.encoding} · 初始DTR ${s.dtr_on_open ? '开启' : '关闭'} · 初始RTS ${s.rts_on_open === null ? '由硬件流控管理' : s.rts_on_open ? '开启' : '关闭'}`;
  throw new Error('此协议尚未开放Agent建连批准。');
}
export class ProfileGrantApproval {
  private current?: ProfileProposal;
  invalidate() { this.current = undefined; }
  prepare(service_id: string, revision: string, profile: Profile, seconds: number, reconnect?: Connection & { profile_id: string }, task?: TaskContext): ProfileProposal {
    this.invalidate();
    if (!uuid(service_id) || !uuid(revision) || !uuid(profile.id) || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 1800) throw new Error('请核对已保存配置、版本与1–1800秒期限。');
    if (reconnect && (!uuid(reconnect.connection_id) || !Number.isSafeInteger(reconnect.generation) || reconnect.generation < 1 || !uuid(reconnect.profile_id) || profile.settings.protocol !== 'ssh2' || reconnect.protocol !== 'SSH2' || !['DISCONNECTED', 'FAILED'].includes(reconnect.state) || reconnect.profile_id !== profile.id)) throw new Error('重连只适用于原配置匹配的已断开SSH2代次。');
    const scopes: Scope[] = reconnect ? [
      Object.freeze({ target: Object.freeze({ kind: 'connection', connection: Object.freeze({ connection_id: reconnect.connection_id, generation: reconnect.generation }) }), action: 'RECONNECT' }),
      Object.freeze({ target: Object.freeze({ kind: 'profile_revision', profile_id: profile.id, revision }), action: 'CONNECT' }),
    ] : [Object.freeze({ target: Object.freeze({ kind: 'profile_revision', profile_id: profile.id, revision }), action: 'CONNECT' })];
    Object.freeze(scopes);
    this.current = Object.freeze({ service_id, profile_id: profile.id, revision, name: profile.name, protocol: profile.settings.protocol.toUpperCase(), description: profileDescription(profile), lifetime_ms: seconds * 1000, scopes, ...(task ? { task: checkedTask(task) } : {}) });
    return this.current;
  }
  consume(service_id: string, revision: string | undefined, profile_id: string, proposal: ProfileProposal, task?: TaskContext): ProfileProposal {
    const valid = this.current === proposal && sameTask(task, proposal.task) && proposal.service_id === service_id && proposal.revision === revision && proposal.profile_id === profile_id;
    this.invalidate();
    if (!valid) throw new Error('配置预览已失效；请重新读取并核对。');
    return proposal;
  }
}
