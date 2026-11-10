import {Panel,Field} from './ui';
import {availabilityText,closeFacts,type PreviousClose} from './close-receipt';
const stages:Record<string,string>={SUBMIT:'接纳',APPEND:'追加',CHECKPOINT:'同步检查点',FLUSH_BARRIER:'刷新屏障',CLOSE_BARRIER:'关闭屏障'};
const kinds:Record<string,string>={QUEUE_FULL:'队列达到上限',CHANNEL_DISCONNECTED:'记录通道已断开',SEQUENCE_EXHAUSTED:'记录编号已用尽',IO_FAILURE:'I/O 类别失败'};
export function CloseReceiptPanel({previous,close}:{previous:PreviousClose|undefined;close():void}){
  const r=previous?.receipt,f=r?closeFacts(r):undefined,d=r?.reader.diagnostic;
  const time=r?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(Number(r.recorded_at_ms))):'';
  return <Panel title="上次关闭信息" close={close} closeLabel="关闭退出信息"><p>{previous?availabilityText[previous.availability]:'关闭记录尚未可用。'}</p>{r&&f&&<>
    <p>这是本数据根中上次可用的关闭记录。未记录的崩溃或未确认的保存不在此回执中。</p>
    <Field label="记录时间（北京时间）"><span aria-label="上次关闭时间">{time}</span></Field>
    <Field label="上次服务"><code aria-label="上次关闭服务">{r.service_id}</code></Field>
    <Field label="上次本地进程"><span>{r.owned_pid}</span></Field>
    <Field label="关闭请求"><span aria-label="上次关闭确认">{f.shutdown}</span></Field>
    <Field label="进程退出"><span aria-label="上次进程退出">{f.process}</span></Field>
    <Field label="强退请求"><span aria-label="上次强退请求">{f.kill}</span></Field>
    <Field label="审计关闭"><span aria-label="上次审计关闭">{f.audit}</span></Field>
    {d&&<><Field label="审计接纳 / 同步 / 拒绝水位"><span>{d.accepted??'未知'} / {d.synced??'未知'} / {d.rejected??'未知'}</span></Field><Field label="历史不完整段"><span>{d.incomplete??'未知'}</span></Field>{d.first_failure&&<Field label="首次审计失败"><span>{stages[d.first_failure.stage]??'未知阶段'} · {kinds[d.first_failure.kind]??'未知类别'}</span></Field>}<p>这些数值是此次关闭时的审计快照。</p></>}
  </>}</Panel>;
}
