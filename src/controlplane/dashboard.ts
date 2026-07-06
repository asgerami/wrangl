import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The control-plane dashboard: a single self-contained HTML page (no build
 * step, no external assets) served at `/`. It drives the REST API in the
 * browser to create servers, inspect tools, browse logs, and copy MCP URLs.
 * Loaded from the sibling .html file so it stays plain HTML to edit.
 */
export const DASHBOARD_HTML: string = readFileSync(
  fileURLToPath(new URL("./dashboard.html", import.meta.url)),
  "utf8",
);
