import type { PaneKey, PaneLayout, PaneLive } from './pane-layout';

type ConnectionRef = Pick<PaneLive, 'connection_id' | 'generation'>;

export type CopyRead = {
  key: PaneKey;
  owner: string;
  detachedId?: string;
};

export type CopyRoute = CopyRead & { source: PaneLive };

type CopyDialog = {
  route: CopyRoute;
  received: Set<string>;
  currentResult?: ConnectionRef;
};

const sameRef = (a: ConnectionRef, b: ConnectionRef) =>
  a.connection_id === b.connection_id && a.generation === b.generation;
const matches = (live: PaneLive, exact: ConnectionRef, protocol: string) =>
  sameRef(live, exact) && live.protocol === protocol;

export function copyRouteCurrent(route: CopyRoute, owner: string | undefined,
  layout: Pick<PaneLayout, 'hasPane' | 'paneOf'>, live: readonly PaneLive[], sourceAvailable: boolean) {
  if (!owner || route.owner !== owner || !layout.hasPane(route.key)) return false;
  const { source } = route;
  return !!route.detachedId || sourceAvailable && layout.paneOf(source.connection_id) === route.key &&
    live.some(item => matches(item, source, source.protocol) && item.state === 'CONNECTED');
}

export class SessionCopy {
  private reading?: CopyRead;
  private dialog?: CopyDialog;
  private placement?: { route: CopyRoute; child: ConnectionRef };

  startRead(read: CopyRead) {
    if (this.reading || this.dialog) return false;
    this.reading = read;
    return true;
  }

  isReadingDetached(id: string) {
    return this.reading?.detachedId === id;
  }

  finishRead(read: CopyRead) {
    if (this.reading === read) this.reading = undefined;
  }

  open(read: CopyRead, source: PaneLive) {
    if (this.reading !== read || this.dialog) return;
    const route = { ...read, source: { ...source } };
    this.dialog = { route, received: new Set() };
    return route;
  }

  owns(route: CopyRoute) {
    return this.dialog?.route === route;
  }

  close(route: CopyRoute, connected: boolean) {
    if (!this.owns(route)) return false;
    if (!connected && this.placement?.route === route) this.placement = undefined;
    this.dialog = undefined;
    return true;
  }

  acceptResult(route: CopyRoute, result: ConnectionRef) {
    const dialog = this.dialog;
    if (dialog?.route !== route || route.source.connection_id === result.connection_id) return false;
    const key = `${result.connection_id}:${result.generation}`;
    if (dialog.received.has(key)) return false;
    dialog.received.add(key);
    dialog.currentResult = { ...result };
    if (!route.detachedId) this.placement = { route, child: dialog.currentResult };
    return true;
  }

  ownsResult(route: CopyRoute, result: ConnectionRef) {
    const dialog = this.dialog;
    return dialog?.route === route && !!dialog.currentResult && sameRef(dialog.currentResult, result);
  }

  takePlacement(owner: string | undefined, live: readonly PaneLive[]) {
    const placement = this.placement;
    if (!placement) return;
    const { route, child: expected } = placement;
    if (route.owner !== owner) {
      this.placement = undefined;
      return;
    }
    const child = live.find(item => matches(item, expected, route.source.protocol));
    if (!child) return;
    this.placement = undefined;
    const anchor = live.find(item => matches(item, route.source, route.source.protocol));
    if (anchor) return { route, anchor, child };
  }
}
