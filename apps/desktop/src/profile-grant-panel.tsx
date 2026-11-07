import { useEffect, useRef, useState } from 'react';
import { readConfiguration, type Profile } from './config-api';
import { ProfileGrantApproval, profileDescription, type ProfileProposal } from './profile-grant';
import { Field } from './ui';
import type { Connection } from './ssh-api';
import type { TaskContext } from './agent-management';

export function ProfileGrantPanel({ serviceId, disabled, reconnectTarget, task, submit }: { serviceId: string; disabled: boolean; reconnectTarget?: Connection & { profile_id: string }; task?: TaskContext; submit(proposal: ProfileProposal, current: () => boolean): Promise<void> }) {
  const approval = useRef(new ProfileGrantApproval()), epoch = useRef(0), alive = useRef(true), loading = useRef(false), submitting = useRef(false);
  const [profiles, setProfiles] = useState<Profile[]>([]), [revision, setRevision] = useState<string>();
  const [selected, setSelected] = useState(''), [seconds, setSeconds] = useState(300), [consent, setConsent] = useState(false);
  const [proposal, setProposal] = useState<ProfileProposal>(), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('显式读取已保存配置后选择目标；默认不批准建连。');
  const invalidate = () => { epoch.current++; approval.current.invalidate(); setProposal(undefined); setConsent(false); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; approval.current.invalidate(); }; }, []);
  useEffect(() => { invalidate(); }, [task?.task_id, task?.label]);
  const profile = profiles.find(item => item.id === selected);
  const reconnect = !!reconnectTarget;
  return <fieldset disabled={disabled || busy} aria-label={reconnect ? 'Agent重连批准面板' : 'Agent配置建连面板'}><legend>{reconnect ? '批准SSH旧代次重连' : '批准已保存配置建连'}</legend>
    <p role="status" aria-label="Agent配置状态">{message}</p>
    <button onClick={() => {
      if (loading.current) return;
      invalidate(); const attempt = epoch.current; loading.current = true; setBusy(true); setMessage('正在读取已保存配置；尚未批准。'); setSelected(''); setRevision(undefined); setProfiles([]);
      void readConfiguration().then(snapshot => {
        if (!alive.current || attempt !== epoch.current) return;
        setProfiles(snapshot.profiles.filter(item => reconnect ? item.settings.protocol === 'ssh2' && item.id === reconnectTarget?.profile_id : item.settings.protocol === 'ssh2' || item.settings.protocol === 'serial')); setRevision(snapshot.revision); setMessage(reconnect ? '只列出该SSH会话原配置；重连将同时请求旧代次Reconnect与此固定revision的Connect。' : '已读取固定配置库版本。保存配置或偏好会改变版本；批准前会再核对，变更后须重新预览。');
      }).catch(error => { if (alive.current && attempt === epoch.current) setMessage(String(error)); }).finally(() => { loading.current = false; if (alive.current) setBusy(false); });
    }}>{reconnect ? '读取重连固定配置' : '读取Agent建连配置'}</button>
    <Field label="已保存配置"><select aria-label="Agent建连配置" value={selected} onChange={event => { invalidate(); setSelected(event.target.value); }}><option value="">{reconnect ? '选择原SSH2配置' : '选择SSH2或串口配置'}</option>{profiles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.settings.protocol.toUpperCase()}</option>)}</select></Field>
    {profile && <div aria-label="Agent配置摘要"><p>{profile.name} · {profile.id} · 配置版本 {revision}</p><p>{profileDescription(profile)}</p></div>}
    <p>{reconnect ? '重连需同时持有此旧代次的Reconnect与该配置固定revision的Connect。退休后不把旧代次读写、认证或lease授权迁移到新连接；批准本身不会重连。主机信任和凭据仍须Desktop处理。' : 'Connect只允许按此固定配置发起新连接，不授新连接的读取、写入、exec、控制、断开、库存枚举、租约或认证批准。批准本身不会建连。串口打开会应用以上初始控制线；驱动打开已开始后不能承诺撤回。'}</p>
    <Field label="建连授权期限（秒，1–1800）"><input type="number" min={1} max={1800} aria-label="Agent建连秒数" value={seconds} onChange={event => { invalidate(); setSeconds(Number(event.target.value)); }} /></Field>
    <button disabled={!profile || !revision || (reconnect && (!reconnectTarget || reconnectTarget.state === 'CONNECTED'))} onClick={() => { try { if (!profile || !revision) return; invalidate(); setProposal(approval.current.prepare(serviceId, revision, profile, seconds, reconnectTarget, task)); } catch (error) { setMessage(String(error)); } }}>{reconnect ? '预览Agent重连双范围' : '预览Agent建连授权'}</button>
    {proposal && <fieldset><legend>核对固定配置</legend>
      {proposal.task && <p aria-label="Agent任务预览">限时任务 {proposal.task.task_id} · {proposal.task.label} · 仅以下固定范围，任务说明不增加权限</p>}
      <div aria-label="Agent建连预览"><p>{reconnectTarget && <>{reconnectTarget.connection_id} / 旧代次 {reconnectTarget.generation} · </>}{proposal.name} · {proposal.protocol} · {proposal.profile_id} · 配置版本 {proposal.revision} · {proposal.lifetime_ms / 1000} 秒</p><p>{proposal.description}</p><p>{reconnect ? '只对以上旧SSH代次请求Reconnect，并以固定配置revision取得Connect；审核/查询原编号不续租。' : '配置读取匹配后，本次打开使用该不可变快照；之后编辑不会替换在途参数。库版本改变会阻止后续新Start。原Start编号只查回执，不重新打开。'}</p></div>
      <label className="check"><input type="checkbox" aria-label={reconnect ? '同意Agent重连双范围' : '同意Agent固定配置建连'} checked={consent} onChange={event => setConsent(event.target.checked)} />{reconnect ? '我只批准以上旧代次Reconnect、固定revision Connect与期限' : '我只批准以上固定配置和期限的Connect'}</label>
      <div className="config-actions"><button autoFocus onClick={() => { invalidate(); setMessage('已取消预览；未签发。'); }}>{reconnect ? '取消Agent重连批准' : '取消Agent建连批准'}</button><button disabled={!consent} onClick={() => {
        if (submitting.current) return;
        submitting.current = true;
        try {
          const fixed = approval.current.consume(serviceId, revision, selected, proposal, task); invalidate(); const attempt = epoch.current;
          void submit(fixed, () => alive.current && attempt === epoch.current).finally(() => { submitting.current = false; });
        } catch (error) { submitting.current = false; invalidate(); setMessage(String(error)); }
      }}>{reconnect ? '确认批准Agent重连' : '确认批准Agent建连'}</button></div>
    </fieldset>}
  </fieldset>;
}
