import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RequestLog } from "./proxy.js";

/**
 * Persistent usage-log store (the Usage Logs feature), backed by SQLite via
 * Node's built-in `node:sqlite` — no external dependency. Each generated server
 * records one row per tool call so calls can be tailed and queried later for
 * debugging agent workflows.
 */

export interface LogRow {
  id: number;
  server: string;
  tool: string;
  method: string;
  url: string;
  status_code: number | null;
  latency_ms: number;
  error: string | null;
  request_body: string | null;
  response_body: string | null;
  /** Unix epoch milliseconds. */
  timestamp: number;
}

export interface LogQuery {
  server?: string;
  tool?: string;
  /** Exact status code, e.g. 200 or 401. */
  status?: number;
  /** Only return rows with id greater than this (for tailing). */
  afterId?: number;
  /** Only rows at/after this epoch-ms timestamp. */
  since?: number;
  limit?: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS request_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    server        TEXT    NOT NULL,
    tool          TEXT    NOT NULL,
    method        TEXT    NOT NULL,
    url           TEXT    NOT NULL,
    status_code   INTEGER,
    latency_ms    INTEGER NOT NULL,
    error         TEXT,
    request_body  TEXT,
    response_body TEXT,
    timestamp     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_logs_server ON request_logs(server);
  CREATE INDEX IF NOT EXISTS idx_logs_tool   ON request_logs(tool);
`;

export class LogStore {
  private db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Open (creating parent dirs and schema as needed) a store at `path`. */
  static open(path: string): LogStore {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    return new LogStore(db);
  }

  /** Persist one tool-call log entry under the given server name. */
  record(server: string, entry: RequestLog): void {
    this.db
      .prepare(
        `INSERT INTO request_logs
           (server, tool, method, url, status_code, latency_ms, error,
            request_body, response_body, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
  }

  /** Query logs newest-first, filtered by the given criteria. */
  query(q: LogQuery = {}): LogRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (q.server) (where.push("server = ?"), params.push(q.server));
    if (q.tool) (where.push("tool = ?"), params.push(q.tool));
    if (q.status !== undefined) (where.push("status_code = ?"), params.push(q.status));
    if (q.afterId !== undefined) (where.push("id > ?"), params.push(q.afterId));
    if (q.since !== undefined) (where.push("timestamp >= ?"), params.push(q.since));

    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = q.limit ?? 100;
    // Tailing (afterId) wants ascending order; browsing wants newest-first.
    const order = q.afterId !== undefined ? "ASC" : "DESC";
    return this.db
      .prepare(`SELECT * FROM request_logs ${clause} ORDER BY id ${order} LIMIT ?`)
      .all(...params, limit) as unknown as LogRow[];
  }

  close(): void {
    this.db.close();
  }
}
