import { spawn } from 'node:child_process';
import path from 'node:path';

// Exactly one outstanding request, no retry, no stderr or command text in failures.
export function samplerClient(command, args, timeoutMs = 8000) {
  const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0, pending, fault, buffer = Buffer.alloc(0), exited;
  const stats = { requests: 0, maxLatencyMs: 0, killed: false };
  const diagnostic = (stage, timeout, began) => ({
    stage, exitCode: child.exitCode, signal: child.signalCode,
    timeout, killed: stats.killed, elapsedMs: performance.now() - began,
  });
  const fail = (stage, timeout = false, terminate = true) => {
    if (fault) return;
    const began = pending?.began ?? performance.now();
    if (terminate && child.exitCode === null && child.signalCode === null) {
      stats.killed = true;
      child.kill();
    }
    fault = new Error(`Soak sampler ${stage}`);
    fault.samplerFailure = diagnostic(stage, timeout, began);
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(fault);
      pending = undefined;
    }
  };
  const wait = (id, op) => {
    const began = performance.now();
    return new Promise((resolve, reject) => {
      pending = { id, op, resolve, reject, began, timer: setTimeout(() => fail(id === 0 ? 'startup' : 'deadline', true), timeoutMs) };
    });
  };
  const ready = wait(0);
  ready.catch(() => {});
  const completion = new Promise(resolve => { exited = resolve; });
  child.on('error', () => fail('spawn'));
  child.stdin.on('error', () => fail('request_write'));
  child.stderr.resume();
  child.on('close', (code, signal) => {
    if (pending) fail('exit', false, false);
    if (fault) Object.assign(fault.samplerFailure, { exitCode: code, signal, killed: stats.killed });
    exited({ code, signal, exited: true });
  });
  child.stdout.on('data', chunk => {
    if (fault) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 16384) { fail('response_bound'); return; }
    const end = buffer.indexOf(10);
    if (end < 0) return;
    const line = buffer.subarray(0, end).toString('utf8');
    buffer = buffer.subarray(end + 1);
    if (buffer.length || !pending) { fail('unexpected_response'); return; }
    let response;
    try { response = JSON.parse(line); } catch { fail('response_json'); return; }
    if (!response || typeof response !== 'object' || Array.isArray(response)) { fail('response_schema'); return; }
    if (response.id !== pending.id) { fail('response_id'); return; }
    if (response.failure !== undefined) {
      const stages = ['request', 'system_snapshot', 'power_preflight', 'process_snapshot'];
      if (stages.includes(response.failure)) fail(response.failure, false, false);
      else fail('response_schema');
      return;
    }
    const keys = Object.keys(response).sort().join(',');
    const expected = pending.id === 0 ? 'id,ready' : pending.op === 'stop' ? 'id,stopped' : 'id,result';
    const valid = pending.id === 0 ? response.ready === true : pending.op === 'stop' ? response.stopped === true
      : response.result && typeof response.result === 'object' && !Array.isArray(response.result);
    if (keys !== expected || !valid) { fail('response_schema'); return; }
    stats.maxLatencyMs = Math.max(stats.maxLatencyMs, performance.now() - pending.began);
    clearTimeout(pending.timer);
    pending.resolve(response.result ?? response);
    pending = undefined;
  });
  return {
    ready, stats,
    async request(op, fields = {}) {
      await ready;
      if (fault) throw fault;
      if (pending) throw new Error('Soak sampler single request slot occupied');
      if (sequence >= 2998) throw new Error('Soak sampler request budget');
      const id = ++sequence;
      const payload = JSON.stringify({ id, op, ...fields });
      if (Buffer.byteLength(payload) > 2048) throw new Error('Soak sampler request bound');
      const response = wait(id, op);
      stats.requests++;
      child.stdin.write(payload + '\n');
      return response;
    },
    async close() {
      if (!fault && child.exitCode === null && child.signalCode === null) {
        try { await this.request('stop'); } catch { /* retained in fault */ }
      }
      child.stdin.end();
      const timer = setTimeout(() => { stats.killed = true; child.kill(); }, 1000);
      let exit, limit;
      try {
        exit = await Promise.race([completion, new Promise(resolve => {
          limit = setTimeout(() => resolve({ code: null, signal: null, exited: false }), 3000);
        })]);
      } finally {
        clearTimeout(timer);
        clearTimeout(limit);
      }
      return { ...exit, ...stats, failure: fault?.samplerFailure };
    },
  };
}

export const startSoakSampler = directory => samplerClient('pwsh', [
  '-NoProfile', '-File', 'scripts/lib/Measure-LoadSoak.ps1',
  '-DataRoot', directory, '-ReportRoot', path.resolve('artifacts'),
]);
