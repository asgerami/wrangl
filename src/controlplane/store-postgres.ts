import pg from "pg";
import type { ServerRecord, ServerStore } from "./store.js";

/**
 * Postgres-backed {@link ServerStore} for running multiple control-plane
 * replicas against one shared database. Same tables as the SQLite backend,
 * created on connect. Uses a connection pool.
 */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL,
    spec_source TEXT NOT NULL,
    base_url    TEXT NOT NULL,
    created_at  BIGINT NOT NULL,
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

interface Row {
  id: string;
  name: string;
  slug: string;
  spec_source: string;
  base_url: string;
  created_at: string | number; // BIGINT comes back as a string from pg
  mcp_token: string | null;
}

export class PostgresServerStore implements ServerStore {
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<PostgresServerStore> {
    const pool = new pg.Pool({ connectionString: url });
    await pool.query(SCHEMA);
    return new PostgresServerStore(pool);
  }

  async upsert(r: ServerRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO servers (id, name, slug, spec_source, base_url, created_at, mcp_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, slug = EXCLUDED.slug,
         spec_source = EXCLUDED.spec_source, base_url = EXCLUDED.base_url,
         mcp_token = EXCLUDED.mcp_token`,
      [r.id, r.name, r.slug, r.specSource, r.baseUrl, r.createdAt, r.mcpToken ?? null],
    );
  }

  async all(): Promise<ServerRecord[]> {
    const res = await this.pool.query<Row>(`SELECT * FROM servers ORDER BY created_at ASC`);
    return res.rows.map(fromRow);
  }

  async get(id: string): Promise<ServerRecord | undefined> {
    const res = await this.pool.query<Row>(`SELECT * FROM servers WHERE id = $1`, [id]);
    return res.rows[0] ? fromRow(res.rows[0]) : undefined;
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM servers WHERE id = $1`, [id]);
    await this.pool.query(`DELETE FROM credentials WHERE server_id = $1`, [id]);
    await this.pool.query(`DELETE FROM oauth WHERE server_id = $1`, [id]);
  }

  async setCredential(serverId: string, scheme: string, valueEnc: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO credentials (server_id, scheme, value_enc) VALUES ($1, $2, $3)
       ON CONFLICT (server_id, scheme) DO UPDATE SET value_enc = EXCLUDED.value_enc`,
      [serverId, scheme, valueEnc],
    );
  }

  async credentialsFor(serverId: string): Promise<Record<string, string>> {
    const res = await this.pool.query<{ scheme: string; value_enc: string }>(
      `SELECT scheme, value_enc FROM credentials WHERE server_id = $1`,
      [serverId],
    );
    const out: Record<string, string> = {};
    for (const r of res.rows) out[r.scheme] = r.value_enc;
    return out;
  }

  async setOAuth(serverId: string, scheme: string, dataEnc: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth (server_id, scheme, data_enc) VALUES ($1, $2, $3)
       ON CONFLICT (server_id, scheme) DO UPDATE SET data_enc = EXCLUDED.data_enc`,
      [serverId, scheme, dataEnc],
    );
  }

  async oauthFor(serverId: string): Promise<Record<string, string>> {
    const res = await this.pool.query<{ scheme: string; data_enc: string }>(
      `SELECT scheme, data_enc FROM oauth WHERE server_id = $1`,
      [serverId],
    );
    const out: Record<string, string> = {};
    for (const r of res.rows) out[r.scheme] = r.data_enc;
    return out;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function fromRow(row: Row): ServerRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    specSource: row.spec_source,
    baseUrl: row.base_url,
    createdAt: Number(row.created_at),
    mcpToken: row.mcp_token ?? undefined,
  };
}
