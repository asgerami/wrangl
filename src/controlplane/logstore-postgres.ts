import pg from "pg";
import type { LogStore, LogRow, LogQuery } from "../runtime/logstore.js";
import type { RequestLog } from "../runtime/proxy.js";

/**
 * Postgres-backed {@link LogStore} — usage logs shared across control-plane
 * replicas. A BIGSERIAL id keeps the same ascending-for-tail / descending-for-
 * browse semantics as the SQLite backend.
 */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS request_logs (
    id            BIGSERIAL PRIMARY KEY,
    server        TEXT    NOT NULL,
    tool          TEXT    NOT NULL,
    method        TEXT    NOT NULL,
    url           TEXT    NOT NULL,
    status_code   INTEGER,
    latency_ms    INTEGER NOT NULL,
    error         TEXT,
    request_body  TEXT,
    response_body TEXT,
    timestamp     BIGINT  NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_logs_server ON request_logs(server);
  CREATE INDEX IF NOT EXISTS idx_logs_tool   ON request_logs(tool);
`;

interface Row extends Omit<LogRow, "id" | "timestamp"> {
  id: string; // BIGSERIAL/BIGINT arrive as strings
  timestamp: string;
}

export class PostgresLogStore implements LogStore {
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string): Promise<PostgresLogStore> {
    const pool = new pg.Pool({ connectionString: url });
    await pool.query(SCHEMA);
    return new PostgresLogStore(pool);
  }

  async record(server: string, entry: RequestLog): Promise<void> {
    await this.pool.query(
      `INSERT INTO request_logs
         (server, tool, method, url, status_code, latency_ms, error,
          request_body, response_body, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        server,
        entry.tool,
        entry.method,
        entry.url,
        entry.statusCode ?? null,
        entry.latencyMs,
        entry.error ?? null,
        entry.requestBody ?? null,
        entry.responseBody ?? null,
        Date.now(),
      ],
    );
  }

  async query(q: LogQuery = {}): Promise<LogRow[]> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    const p = () => `$${params.length + 1}`;
    if (q.server) (where.push(`server = ${p()}`), params.push(q.server));
    if (q.tool) (where.push(`tool = ${p()}`), params.push(q.tool));
    if (q.status !== undefined) (where.push(`status_code = ${p()}`), params.push(q.status));
    if (q.afterId !== undefined) (where.push(`id > ${p()}`), params.push(q.afterId));
    if (q.since !== undefined) (where.push(`timestamp >= ${p()}`), params.push(q.since));

    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const order = q.afterId !== undefined ? "ASC" : "DESC";
    const limitPlaceholder = p(); // compute the placeholder before pushing
    params.push(q.limit ?? 100);
    const res = await this.pool.query<Row>(
      `SELECT * FROM request_logs ${clause} ORDER BY id ${order} LIMIT ${limitPlaceholder}`,
      params,
    );
    return res.rows.map((r) => ({ ...r, id: Number(r.id), timestamp: Number(r.timestamp) }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
