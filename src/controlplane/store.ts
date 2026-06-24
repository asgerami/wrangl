import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable store for control-plane server records, backed by SQLite via Node's
 * built-in `node:sqlite`. Persists the metadata needed to rebuild a server on
 * restart (spec source, name, base URL) — NOT credentials. Secrets stay out of
 * this file; they are re-derived from the environment on boot, pending the
 * encrypted-credential feature. Can share the same database file as the usage
 * log store.
 */

export interface ServerRecord {
  id: string;
  name: string;
  slug: string;
  specSource: string;
  baseUrl: string;
  createdAt: number;
}

interface Row {
  id: string;
  name: string;
  slug: string;
  spec_source: string;
  base_url: string;
  created_at: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    spec_source TEXT NOT NULL,
    base_url    TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS credentials (
    server_id   TEXT NOT NULL,
    scheme      TEXT NOT NULL,
    value_enc   TEXT NOT NULL,
    PRIMARY KEY (server_id, scheme)
  );
`;

export class ServerStore {
  private db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(path: string): ServerStore {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    return new ServerStore(db);
  }

  /** Insert or update a server record (keyed by id). */
  upsert(record: ServerRecord): void {
    this.db
      .prepare(
        `INSERT INTO servers (id, name, slug, spec_source, base_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           slug = excluded.slug,
           spec_source = excluded.spec_source,
           base_url = excluded.base_url`,
      )
      .run(
        record.id,
        record.name,
        record.slug,
        record.specSource,
        record.baseUrl,
        record.createdAt,
      );
  }

  /** All persisted records, oldest first (stable restore order). */
  all(): ServerRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM servers ORDER BY created_at ASC`)
      .all() as unknown as Row[];
    return rows.map(fromRow);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM servers WHERE id = ?`).run(id);
    this.db.prepare(`DELETE FROM credentials WHERE server_id = ?`).run(id);
  }

  /** Store an already-encrypted credential envelope for a server scheme. */
  setCredential(serverId: string, scheme: string, valueEnc: string): void {
    this.db
      .prepare(
        `INSERT INTO credentials (server_id, scheme, value_enc) VALUES (?, ?, ?)
         ON CONFLICT(server_id, scheme) DO UPDATE SET value_enc = excluded.value_enc`,
      )
      .run(serverId, scheme, valueEnc);
  }

  /** All encrypted credentials for a server, keyed by scheme. */
  credentialsFor(serverId: string): Record<string, string> {
    const rows = this.db
      .prepare(`SELECT scheme, value_enc FROM credentials WHERE server_id = ?`)
      .all(serverId) as unknown as Array<{ scheme: string; value_enc: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.scheme] = r.value_enc;
    return out;
  }

  close(): void {
    this.db.close();
  }
}

function fromRow(row: Row): ServerRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    specSource: row.spec_source,
    baseUrl: row.base_url,
    createdAt: row.created_at,
  };
}
