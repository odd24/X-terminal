import { Field } from './ui';
import { ruleDisplay, type Redaction } from './output-protection';

export function OutputProtectionEditor({ value, change, required = false }: { value?: Redaction; change(value?: Redaction): void; required?: boolean }) {
  return <fieldset aria-label="Agent输出保护设置"><legend>输出保护</legend>
    {required ? <p>此导出必须启用输出保护。文件只接收应用规则后的文本。</p> : <label className="check"><input aria-label="启用Agent输出保护" type="checkbox" checked={!!value} onChange={e => change(e.target.checked ? { sensitive_fields: true, literals: [] } : undefined)} />仅向Agent提供服务端保护后的文本与屏幕</label>}
    {!value ? <small>未启用保护：按本次Read或本人exec批准提供原始上下文。敏感内容可能出现，请按需要启用保护。</small> : <>
      <label className="check"><input aria-label="Agent敏感字段保护" type="checkbox" checked={value.sensitive_fields} onChange={e => change({ ...value, sensitive_fields: e.target.checked })} />隐藏已知密码、token、密钥字段及PEM私钥块</label>
      <small>精确文本逐字匹配，保留空白与换行，区分大小写；最多32条，每条256 UTF-8字节。至少启用字段或一条非空规则。</small>
      {value.literals.map((literal, i) => <div key={i}>
        <Field label={`精确文本规则 ${i + 1}`}><textarea aria-label={`Agent精确文本规则${i + 1}`} rows={2} maxLength={256} value={literal} onChange={e => change({ ...value, literals: value.literals.map((v, n) => n === i ? e.target.value : v) })} /></Field>
        <button onClick={() => change({ ...value, literals: value.literals.filter((_, n) => n !== i) })}>移除精确规则 {i + 1}</button>
      </div>)}
      <button disabled={value.literals.length >= 32} onClick={() => change({ ...value, literals: [...value.literals, ''] })}>添加精确文本规则</button>
      <p>规则固定在本票据，不改变原始输出或日志。保护模式拒绝原始字节及旧读取入口；边界不明可能隐藏整段，屏幕可能隐藏整行或整屏。未知密码、混淆或其他格式不保证识别。</p>
    </>}
  </fieldset>;
}
export function OutputProtectionPreview({ value }: { value?: Redaction }) {
  return <div aria-label="Agent输出保护预览">{value ? <>
    <strong>本次固定输出保护：敏感字段{value.sensitive_fields ? '开启' : '关闭'} · 精确规则 {value.literals.length} 条</strong>
    {value.literals.length > 0 && <ol>{value.literals.map((literal, i) => <li key={i}><pre>{ruleDisplay(literal)}</pre></li>)}</ol>}
    <p>以上完整规则只用于此票据的获准内容，仍不增加Read或其他权限。原始字节读取拒绝；截断前文/控制重写可能保守隐藏。不是完整敏感信息检测。查询编号不恢复规则正文或同意。</p>
  </> : <p>本次未启用输出保护；批准范围内的原始上下文可能包含敏感内容。</p>}</div>;
}
