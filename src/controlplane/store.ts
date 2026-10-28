import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolFilter } from "../generator/filter.js";

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
  /** The `include` / `exclude` filter the server was created with. */
  toolFilter?: ToolFilter;
  /**
   * Version of the record, raised on every write. Replicas compare it with
   * their cached copy to notice changes made elsewhere.
   */
  updatedAt?: number;
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
  /**
   * Save an OAuth authorization in progress (encrypted), keyed by its CSRF
   * state. Shared so the provider's redirect can land on any replica.
   */
  savePendingAuth(state: string, dataEnc: string, createdAt: number): Promise<void>;
  /** Remove and return a pending authorization, atomically, so a state works once. */
  takePendingAuth(state: string): Promise<PendingAuthRow | undefined>;
  /** Drop pending authorizations created before `cutoff` (epoch ms). */
  prunePendingAuth(cutoff: number): Promise<void>;
  close(): Promise<void>;
}

export interface PendingAuthRow {
  dataEnc: string;
  createdAt: number;
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
  tool_filter: string | null;
  updated_at: number | null;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    spec_source TEXT NOT NULL,
    base_url    TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    mcp_token   TEXT,
    tool_filter TEXT,
    updated_at  INTEGER
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
  CREATE TABLE IF NOT EXISTS oauth_pending (
    state       TEXT PRIMARY KEY,
    data_enc    TEXT NOT NULL,
    created_at  INTEGER NOT NULL
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
    // Migrate databases created before these columns existed.
    const cols = db.prepare("PRAGMA table_info(servers)").all() as Array<{ name: string }>;
    const added = { mcp_token: "TEXT", tool_filter: "TEXT", updated_at: "INTEGER" };
    for (const [column, type] of Object.entries(added)) {
      if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE servers ADD COLUMN ${column} ${type}`);
      }
    }
    return new SqliteServerStore(db);
  }

  async upsert(record: ServerRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO servers
           (id, name, slug, spec_source, base_url, created_at, mcp_token, tool_filter, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           slug = excluded.slug,
           spec_source = excluded.spec_source,
           base_url = excluded.base_url,
           mcp_token = excluded.mcp_token,
           tool_filter = excluded.tool_filter,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.name,
        record.slug,
        record.specSource,
        record.baseUrl,
        record.createdAt,
        record.mcpToken ?? null,
        encodeToolFilter(record.toolFilter),
        record.updatedAt ?? null,
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

  async savePendingAuth(state: string, dataEnc: string, createdAt: number): Promise<void> {
    this.db
      .prepare(`INSERT INTO oauth_pending (state, data_enc, created_at) VALUES (?, ?, ?)`)
      .run(state, dataEnc, createdAt);
  }

  async takePendingAuth(state: string): Promise<PendingAuthRow | undefined> {
    const row = this.db
      .prepare(`DELETE FROM oauth_pending WHERE state = ? RETURNING data_enc, created_at`)
      .get(state) as { data_enc: string; created_at: number } | undefined;
    return row ? { dataEnc: row.data_enc, createdAt: row.created_at } : undefined;
  }

  async prunePendingAuth(cutoff: number): Promise<void> {
    this.db.prepare(`DELETE FROM oauth_pending WHERE created_at < ?`).run(cutoff);
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
    toolFilter: decodeToolFilter(row.tool_filter),
    updatedAt: row.updated_at ?? undefined,
  };
}

/** Store a tool filter as JSON; null when it would keep every tool. */
export function encodeToolFilter(filter: ToolFilter | undefined): string | null {
  return filter?.include?.length || filter?.exclude?.length ? JSON.stringify(filter) : null;
}

export function decodeToolFilter(json: string | null): ToolFilter | undefined {
  return json ? (JSON.parse(json) as ToolFilter) : undefined;
}
