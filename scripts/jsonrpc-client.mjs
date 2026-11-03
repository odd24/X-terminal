import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function processRpc(command, args, options = {}) {
  const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const notifications = [];
  let id = 0;
  let stderr = '';
  let protocolError;
  const fail = error => {
    protocolError = error;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  child.on('error', fail);
  const exited = new Promise(resolve => child.once('exit', (code, signal) => { fail(new Error(`RPC process exited: ${code ?? signal}`)); resolve({ code, signal }); }));
  child.stderr.on('data', data => { stderr = (stderr + data.toString('utf8')).slice(-32768); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { fail(new Error('Non-JSON protocol stdout')); return; }
    if (message.method && message.id !== undefined) {
      // Never grant permissions or execute callbacks requested by a tested process.
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Test client callback unsupported' } }) + '\n');
      return;
    }
    if (message.method) { notifications.push(message); return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    request.resolve(message);
  });
  function begin(method, params, timeoutMs = 10000) {
    const requestId = ++id;
    const promise = new Promise((resolve, reject) => {
      if (protocolError) { reject(protocolError); return; }
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`RPC timeout: ${method}`)); }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
    return { id: requestId, promise };
  }
  return {
    child, notifications, begin,
    get stderr() { return stderr; },
    request: (method, params, timeoutMs) => begin(method, params, timeoutMs).promise,
    notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    cancel(requestId, reason) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason } }) + '\n');
      const request = pending.get(requestId);
      if (request) { clearTimeout(request.timer); pending.delete(requestId); request.reject(new Error('Cancelled by test client')); }
    },
    async close() {
      child.stdin.end();
      const deadline = setTimeout(() => child.kill(), 3000);
      try { return await exited; } finally { clearTimeout(deadline); lines.close(); }
    },
  };
}
