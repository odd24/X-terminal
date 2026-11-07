import type { GrantView } from './agent-management';

export type Redaction = { sensitive_fields: boolean; literals: string[] };
export type ProtectionInfo = { policy_id: string; sensitive_fields: boolean; literal_count: number };

export function checkedRedaction(value: Redaction): Redaction {
  const valid = value && Object.keys(value).length === 2 && Object.keys(value).every(k => k === 'sensitive_fields' || k === 'literals') && typeof value.sensitive_fields === 'boolean' && Array.isArray(value.literals) && value.literals.length <= 32 && (value.sensitive_fields || value.literals.length > 0) && new Set(value.literals).size === value.literals.length && value.literals.every(v => {
    if (typeof v !== 'string' || !v.length || /[\uD800-\uDFFF]/u.test(v)) return false;
    const bytes = new TextEncoder().encode(v);
    try { return bytes.length <= 256; } finally { bytes.fill(0); }
  });
  if (!valid) throw new Error('输出保护至少启用敏感字段或一条精确文本；最多32条，每条1–256 UTF-8字节，不重复、不自动去空白。');
  return Object.freeze({ sensitive_fields: value.sensitive_fields, literals: Object.freeze([...value.literals]) as unknown as string[] });
}
export function ruleDisplay(value: string): string {
  return JSON.stringify(value).replace(/[\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
export function sameRedaction(a?: Redaction, b?: Redaction): boolean {
  return !a || !b ? a === b : a.sensitive_fields === b.sensitive_fields && a.literals.length === b.literals.length && a.literals.every((v, i) => v === b.literals[i]);
}
export function checkedProtectionReply(view: GrantView, expected?: Redaction): GrantView {
  if (expected ? !view.protection || view.protection.sensitive_fields !== expected.sensitive_fields || view.protection.literal_count !== expected.literals.length : view.protection !== undefined) throw new Error('输出保护回执与固定预览不一致；只查询原签发编号，不重签。');
  return view;
}
