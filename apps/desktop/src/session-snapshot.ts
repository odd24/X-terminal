import type { PreviousClose } from './close-receipt';
import type { Connection } from './ssh-api';

export type ServiceStatus = {
  service_id: string;
  pid: number;
  fixture: boolean;
  ssh1_preview: boolean;
  exit_policy: string;
  previous_close?: PreviousClose;
};

export type SessionSnapshot = {
  service: ServiceStatus;
  sessions: Connection[];
  next_cursors: number[];
};

export function sameService(previous: ServiceStatus | undefined, next: ServiceStatus) {
  // previous_close is fixed when this service instance starts.
  return previous?.service_id === next.service_id && previous.pid === next.pid
    && previous.fixture === next.fixture && previous.ssh1_preview === next.ssh1_preview
    && previous.exit_policy === next.exit_policy;
}

export function sameConnectionList(previous: Connection[], next: Connection[]) {
  return previous.length === next.length && previous.every((connection, index) => {
    const current = next[index];
    return connection.connection_id === current.connection_id && connection.generation === current.generation
      && connection.protocol === current.protocol && connection.state === current.state;
  });
}

export function snapshotCursor(snapshot: SessionSnapshot | undefined, owner: string, visible?: Connection) {
  if (!visible || !snapshot || snapshot.service.service_id !== owner) return undefined;
  // A handoff may already have removed a row from the window's visible list.
  const index = snapshot.sessions.findIndex(row => row.connection_id === visible.connection_id
    && row.generation === visible.generation && row.protocol === visible.protocol);
  return snapshot.next_cursors[index];
}

type Subscription = {
  read(): Promise<SessionSnapshot>;
  epoch(): number;
  apply(snapshot: SessionSnapshot, requestEpoch: number): void;
  failed(): void;
};

export function subscribeSessionSnapshots({read, epoch, apply, failed}: Subscription) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout>;
  async function poll() {
    try {
      const requestEpoch = epoch();
      const snapshot = await read();
      if (disposed) return;
      apply(snapshot, requestEpoch);
      if (!disposed) timer = setTimeout(poll, 100);
    } catch {
      if (!disposed) failed();
    }
  }
  void poll();
  return () => {
    disposed = true;
    clearTimeout(timer);
  };
}
