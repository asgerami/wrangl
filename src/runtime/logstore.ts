import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RequestLog } from "./proxy.js";

/**
 * Persistent usage-log store (the Usage Logs feature). Two interchangeable
 * backends implement {@link LogStore}: SQLite (default) and Postgres (for
 * multiple replicas sharing one database). Each generated server records one
 * row per tool call so calls can be tailed and queried later.
 */

export interface LogStore {
  record(server: string, entry: RequestLog): Promise<void>;
  query(q?: LogQuery): Promise<LogRow[]>;
  /** Delete rows logged before `before` (epoch ms); returns how many went. */
  prune(before: number): Promise<number>;
  close(): Promise<void>;
}

/**
 * Open the configured log store. `location` is a SQLite file path, or a
 * `postgres://` URL for the shared backend.
 */
export async function openLogStore(location: string): Promise<LogStore> {
  if (/^postgres(ql)?:\/\//i.test(location)) {
    const { PostgresLogStore } = await import("../controlplane/logstore-postgres.js");
    return PostgresLogStore.connect(location);
  }
  return SqliteLogStore.open(location);
}

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
  CREATE INDEX IF NOT EXISTS idx_logs_time   ON request_logs(timestamp);
`;

export class SqliteLogStore implements LogStore {
  private db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Open (creating parent dirs and schema as needed) a store at `path`. */
  static open(path: string): SqliteLogStore {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    return new SqliteLogStore(db);
  }

  /** Persist one tool-call log entry under the given server name. */
  async record(server: string, entry: RequestLog): Promise<void> {
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
  async query(q: LogQuery = {}): Promise<LogRow[]> {
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

  async prune(before: number): Promise<number> {
    const result = this.db.prepare(`DELETE FROM request_logs WHERE timestamp < ?`).run(before);
    return Number(result.changes);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/**
 * Keep usage logs for `days` (0 = forever): prune now, then hourly. Logs hold
 * request and response bodies, so they shouldn't pile up indefinitely.
 * Returns a function that stops the hourly pruning.
 */
export function retainLogs(
  store: LogStore,
  days: number,
  onPruned?: (rows: number) => void,
): () => void {
  if (!(days > 0)) return () => {};
  const prune = () =>
    store
      .prune(Date.now() - days * 86_400_000)
      .then((rows) => rows && onPruned?.(rows))
      .catch(() => {}); // never take the server down over housekeeping
  void prune();
  const timer = setInterval(prune, 3_600_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
