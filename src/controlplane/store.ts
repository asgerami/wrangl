import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable store for control-plane server records + encrypted credentials/OAuth
 * tokens. Two interchangeable backends implement {@link ServerStore}: SQLite
 * (default, single-instance, zero-config) and Postgres (shared, for running
 * multiple replicas). The interface is async so both fit behind it.
 */

export interface ServerRecord {
  id: string;
  name: string;
  slug: string;
  specSource: string;
  baseUrl: string;
  createdAt: number;
  /** Per-server Bearer token required to call the hosted MCP endpoint. */
  mcpToken?: string;
}

export interface ServerStore {
  upsert(record: ServerRecord): Promise<void>;
  all(): Promise<ServerRecord[]>;
  /** One record by id (source of truth for read-through across replicas). */
  get(id: string): Promise<ServerRecord | undefined>;
  delete(id: string): Promise<void>;
  setCredential(serverId: string, scheme: string, valueEnc: string): Promise<void>;
  credentialsFor(serverId: string): Promise<Record<string, string>>;
  setOAuth(serverId: string, scheme: string, dataEnc: string): Promise<void>;
  oauthFor(serverId: string): Promise<Record<string, string>>;
  close(): Promise<void>;
}

/** Whether a location string is a Postgres connection URL (vs a SQLite path). */
export function isPostgresUrl(location: string): boolean {
  return /^postgres(ql)?:\/\//i.test(location);
}

/**
 * Open the configured server store. `location` is a SQLite file path, or a
 * `postgres://` connection URL for the shared multi-replica backend.
 */
export async function openServerStore(location: string): Promise<ServerStore> {
  if (isPostgresUrl(location)) {
    const { PostgresServerStore } = await import("./store-postgres.js");
    return PostgresServerStore.connect(location);
  }
  return SqliteServerStore.open(location);
}

interface Row {
  id: string;
  name: string;
  slug: string;
  spec_source: string;
  base_url: string;
  created_at: number;
  mcp_token: string | null;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    spec_source TEXT NOT NULL,
    base_url    TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    mcp_token   TEXT
  );
  CREATE TABLE IF NOT EXISTS credentials (
    server_id   TEXT NOT NULL,
    scheme      TEXT NOT NULL,
    value_enc   TEXT NOT NULL,
    PRIMARY KEY (server_id, scheme)
  );
  CREATE TABLE IF NOT EXISTS oauth (
    server_id   TEXT NOT NULL,
    scheme      TEXT NOT NULL,
    data_enc    TEXT NOT NULL,
    PRIMARY KEY (server_id, scheme)
  );
`;

export class SqliteServerStore implements ServerStore {
  private db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(path: string): SqliteServerStore {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    // Migrate databases created before the per-server MCP token existed.
    const cols = db.prepare("PRAGMA table_info(servers)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "mcp_token")) {
      db.exec("ALTER TABLE servers ADD COLUMN mcp_token TEXT");
    }
    return new SqliteServerStore(db);
  }

  async upsert(record: ServerRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO servers (id, name, slug, spec_source, base_url, created_at, mcp_token)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           slug = excluded.slug,
           spec_source = excluded.spec_source,
           base_url = excluded.base_url,
           mcp_token = excluded.mcp_token`,
      )
      .run(
        record.id,
        record.name,
        record.slug,
        record.specSource,
        record.baseUrl,
        record.createdAt,
        record.mcpToken ?? null,
      );
  }

  async all(): Promise<ServerRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM servers ORDER BY created_at ASC`)
      .all() as unknown as Row[];
    return rows.map(fromRow);
  }

  async get(id: string): Promise<ServerRecord | undefined> {
    const row = this.db.prepare(`SELECT * FROM servers WHERE id = ?`).get(id) as
      | Row
      | undefined;
    return row ? fromRow(row) : undefined;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM servers WHERE id = ?`).run(id);
    this.db.prepare(`DELETE FROM credentials WHERE server_id = ?`).run(id);
    this.db.prepare(`DELETE FROM oauth WHERE server_id = ?`).run(id);
  }

  async setCredential(serverId: string, scheme: string, valueEnc: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO credentials (server_id, scheme, value_enc) VALUES (?, ?, ?)
         ON CONFLICT(server_id, scheme) DO UPDATE SET value_enc = excluded.value_enc`,
      )
      .run(serverId, scheme, valueEnc);
  }

  async credentialsFor(serverId: string): Promise<Record<string, string>> {
    const rows = this.db
      .prepare(`SELECT scheme, value_enc FROM credentials WHERE server_id = ?`)
      .all(serverId) as unknown as Array<{ scheme: string; value_enc: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.scheme] = r.value_enc;
    return out;
  }

  async setOAuth(serverId: string, scheme: string, dataEnc: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO oauth (server_id, scheme, data_enc) VALUES (?, ?, ?)
         ON CONFLICT(server_id, scheme) DO UPDATE SET data_enc = excluded.data_enc`,
      )
      .run(serverId, scheme, dataEnc);
  }

  async oauthFor(serverId: string): Promise<Record<string, string>> {
    const rows = this.db
      .prepare(`SELECT scheme, data_enc FROM oauth WHERE server_id = ?`)
      .all(serverId) as unknown as Array<{ scheme: string; data_enc: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.scheme] = r.data_enc;
    return out;
  }

  async close(): Promise<void> {
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
    mcpToken: row.mcp_token ?? undefined,
  };
}
