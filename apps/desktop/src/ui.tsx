import type { ReactNode } from 'react';

export function Panel({ title, label = title, close, closeLabel = '关闭', children }: {
  title: string; label?: string; close?: () => void; closeLabel?: string; children: ReactNode;
}) {
  return <section className="config-panel" aria-label={label}>
    <div className="config-heading"><h2>{title}</h2>{close && <button onClick={close}>{closeLabel}</button>}</div>
    {children}
  </section>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label>{label}{children}</label>;
}
