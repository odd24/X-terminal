export type CatalogConnection = { connection_id: string; generation: number; protocol: string };
import type { Settings } from './config-api';
export type ConnectionDetails = { profile_id: string; encoding: string; temporary_settings?: Settings | null; target_label?: string };

// Display-only data is scoped to the authoritative service list, never to a
// selected Profile. A late read cannot resurrect a forgotten/previous owner.
export class ConnectionCatalog {
  private owner = '';
  private retained = new Map<string, CatalogConnection>();
  private details = new Map<string, ConnectionDetails>();
  get size() { return this.details.size; }
  retain(owner: string, connections: readonly CatalogConnection[]) {
    if (this.owner !== owner) this.details.clear();
    this.owner = owner;
    const next = new Map(connections.map(item => [item.connection_id, { ...item }]));
    for (const [id, previous] of this.retained) {
      const current = next.get(id);
      if (!current || current.generation !== previous.generation || current.protocol !== previous.protocol) this.details.delete(id);
    }
    this.retained = next;
  }
  put(owner: string, connection: CatalogConnection, details: ConnectionDetails) {
    const current = this.retained.get(connection.connection_id);
    if (owner !== this.owner || !current || current.generation !== connection.generation || current.protocol !== connection.protocol) return false;
    const target = details.temporary_settings;
    this.details.set(connection.connection_id, { profile_id: details.profile_id, encoding: details.encoding, ...(target?.protocol === 'ssh2' ? { target_label: `${target.username}@${target.host}:${target.port}` } : {}) });
    return true;
  }
  get(connection: CatalogConnection) {
    const current = this.retained.get(connection.connection_id);
    return current?.generation === connection.generation && current.protocol === connection.protocol ? this.details.get(connection.connection_id) : undefined;
  }
}
