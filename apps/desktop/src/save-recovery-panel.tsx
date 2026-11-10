import {Field, Panel} from './ui';

export type SaveRecoverySnapshot = {
  availability: string | null;
  items: { save_id: string; name: string; at_ms: number; phase: 'UNKNOWN' | 'PUBLISHED' | 'NOT_PUBLISHED' | 'PRESERVE' }[];
};

const phaseText = {
  UNKNOWN: '结果未知，可能留有暂存或备份',
  PUBLISHED: '记录曾观察到发布完成',
  NOT_PUBLISHED: '记录曾观察到本次未发布',
  PRESERVE: '记录提示可能留有暂存或备份',
};
const availabilityText: Record<string, string> = {
  MISSING: '没有可用的覆盖另存记录。',
  BUSY: '另存记录正在使用，遗留状态未知。',
  UNTRUSTED: '另存记录无法验证，遗留状态未知。',
  UNSUPPORTED: '另存记录版本无法识别，遗留状态未知。',
  CAPACITY: '另存记录超出读取上限，遗留状态未知。',
};
const time = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium',
});

export function saveRecoveryAttention(snapshot: SaveRecoverySnapshot): boolean {
  return !!(snapshot.availability && snapshot.availability !== 'MISSING')
    || snapshot.items.some(item => item.phase === 'UNKNOWN' || item.phase === 'PRESERVE');
}

export function SaveRecoveryPanel({snapshot, close}: {snapshot?: SaveRecoverySnapshot; close(): void}) {
  return <Panel title="另存保全信息" close={close} closeLabel="关闭另存保全信息">
    <p>这些记录描述另存进程当时观察到的阶段。文件当前状态未知，请保留现有文件、备份和暂存以便核对。</p>
    {(!snapshot || snapshot.availability) && <p>{availabilityText[snapshot?.availability ?? ''] ?? '暂时无法读取另存记录，遗留状态未知。'}</p>}
    {snapshot?.availability === null && snapshot.items.length === 0 && <p>没有保留的覆盖另存记录。</p>}
    {snapshot?.items.map(item => <section key={item.save_id} aria-label="另存保全记录">
      <Field label="原保存编号"><code>{item.save_id}</code></Field>
      <Field label="目标基名"><span>{item.name}</span></Field>
      <Field label="记录阶段"><span>{phaseText[item.phase]}</span></Field>
      <Field label="记录时间（北京时间）"><span>{time.format(item.at_ms)}</span></Field>
    </section>)}
  </Panel>;
}
