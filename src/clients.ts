import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEdits,
  findNodeAtLocation,
  format,
  modify,
  parse,
  parseTree,
  type JSONPath,
  type ParseError,
} from "jsonc-parser";

/**
 * Agent-client integration: write a generated MCP server straight into the
 * config file of an agent client, so `wrangl install <api>` is the whole
 * setup. Claude Desktop, Cursor, Windsurf, and Cline all share the same
 * `mcpServers` config shape; Zed (`context_servers`) and VS Code (`servers`)
 * use their own top-level key and per-entry fields.
 */

export const CLIENT_NAMES = ["claude", "cursor", "windsurf", "cline", "zed", "vscode"] as const;
export type ClientName = (typeof CLIENT_NAMES)[number];

export function isClientName(value: string): value is ClientName {
  return (CLIENT_NAMES as readonly string[]).includes(value);
}

export interface McpServerEntry {
  command: string;
  args: string[];
  /** Environment for the server process, e.g. its API key (see `--env`). */
  env?: Record<string, string>;
}

/** Where each supported client keeps its MCP config, per platform. */
export function clientConfigPath(
  client: ClientName,
  home = homedir(),
  cwd = process.cwd(),
): string {
  if (client === "cursor") return join(home, ".cursor", "mcp.json");
  if (client === "windsurf") return join(home, ".codeium", "windsurf", "mcp_config.json");

  // VS Code's native MCP support reads a workspace-relative file.
  if (client === "vscode") return join(cwd, ".vscode", "mcp.json");

  // Cline (VS Code extension) keeps its own settings apart from VS Code's own mcp.json.
  if (client === "cline") {
    if (process.platform === "darwin") {
      return join(
        home,
        "Library",
        "Application Support",
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      );
    }
    if (process.platform === "win32") {
      const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return join(
        appData,
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      );
    }
    return join(
      home,
      ".config",
      "Code",
      "User",
      "globalStorage",
      "saoudrizwan.claude-dev",
      "settings",
      "cline_mcp_settings.json",
    );
  }

  // Zed keeps MCP entries in its general settings.json under "context_servers".
  if (client === "zed") {
    if (process.platform === "win32") {
      const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return join(appData, "Zed", "settings.json");
    }
    return join(home, ".config", "zed", "settings.json");
  }

  // Claude Desktop
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

/** The top-level config key each client reads its server list from. */
export function clientConfigKey(client: ClientName): string {
  if (client === "vscode") return "servers";
  if (client === "zed") return "context_servers";
  return "mcpServers";
}

/** Shape a generic server entry into what this client's config expects. */
export function clientEntry(client: ClientName, entry: McpServerEntry): Record<string, unknown> {
  if (client === "vscode") return { type: "stdio", ...entry };
  if (client === "zed") return { source: "custom", ...entry };
  return { ...entry };
}

/** This package's name and version (src/ and dist/ both sit one level below package.json). */
const PKG: { name: string; version: string } = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
);

/**
 * How to re-invoke *this* CLI from a client config. Works whether Wrangl is run
 * from source (tsx) or installed/compiled (node dist/cli.js), so the config we
 * write actually launches on the user's machine.
 *
 * When it runs from a throwaway location — npx's cache, which npm prunes — the
 * path would stop existing later, so the config launches the published package
 * through npx instead, pinned to this exact version so it can be re-fetched.
 */
export function selfCommand(
  entryPath = process.argv[1] ?? "",
  pkg: { name: string; version: string } = PKG,
): McpServerEntry {
  const abs = resolve(entryPath);
  if (abs.endsWith(".ts")) return { command: "npx", args: ["tsx", abs] };
  if (isEphemeralPath(abs)) return { command: "npx", args: ["-y", `${pkg.name}@${pkg.version}`] };
  return { command: "node", args: [abs] };
}

/** Caches that one-off runners (npx, pnpm dlx, bunx, yarn dlx) install into and may prune. */
function isEphemeralPath(path: string): boolean {
  return /[\\/](_npx|dlx)[\\/]/.test(path) || path.startsWith(tmpdir() + sep);
}

/** Optional flags forwarded into the generated `wrangl generate` command. */
export interface BuildServerEntryOptions {
  baseUrl?: string;
  include?: string[];
  exclude?: string[];
}

/**
 * What the generated server loads: a spec location (URL or absolute file path),
 * or a catalog id, which is resolved at launch against wherever the package is
 * installed then — so a bundled catalog spec never pins a path into a cache.
 */
export type SpecSource = string | { catalog: string };

/** Build the client entry that launches a generated MCP server over stdio. */
export function buildServerEntry(
  source: SpecSource,
  baseUrlOrOpts?: string | BuildServerEntryOptions,
): McpServerEntry {
  const opts: BuildServerEntryOptions =
    typeof baseUrlOrOpts === "string" || baseUrlOrOpts === undefined
      ? { baseUrl: baseUrlOrOpts }
      : baseUrlOrOpts;
  const self = selfCommand();
  const args = [
    ...self.args,
    "generate",
    ...(typeof source === "string" ? ["--spec", source] : ["--catalog", source.catalog]),
  ];
  if (opts.baseUrl) args.push("--base-url", opts.baseUrl);
  for (const pattern of opts.include ?? []) args.push("--include", pattern);
  for (const pattern of opts.exclude ?? []) args.push("--exclude", pattern);
  return { command: self.command, args };
}

export interface InstallResult {
  path: string;
  /** True when an entry with this name already existed and was replaced. */
  replaced: boolean;
  /** Path of the backup written before overwriting an existing config. */
  backup?: string;
}

/**
 * Merge one server into a client's MCP config, preserving every other entry
 * (including unrelated settings in shared files like Zed's settings.json).
 * Creates the file (and parent dirs) when missing, and backs up an existing
 * one before rewriting it.
 *
 * Zed's settings.json and VS Code's mcp.json are JSONC, so comments and
 * trailing commas are accepted, and the file is edited in place: only this
 * server's entry changes, and the user's comments and formatting survive.
 */
export function installServer(
  configPath: string,
  name: string,
  entry: McpServerEntry | Record<string, unknown>,
  configKey = "mcpServers",
): InstallResult {
  const raw = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";

  if (!raw.trim()) {
    mkdirSync(dirname(configPath), { recursive: true });
    const backup = raw ? backupOf(configPath) : undefined;
    writeFileSync(configPath, JSON.stringify({ [configKey]: { [name]: entry } }, null, 2) + "\n");
    return { path: configPath, replaced: false, backup };
  }

  const errors: ParseError[] = [];
  const config: unknown = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length || !isObject(config)) {
    throw new Error(`${configPath} is not valid JSON — fix or move it before installing.`);
  }

  const servers = config[configKey];
  const replaced = isObject(servers) && name in servers;
  // Edit just this entry; a missing or malformed server map is replaced whole.
  const [path, value]: [JSONPath, unknown] = isObject(servers)
    ? [[configKey, name], entry]
    : [[configKey], { [name]: entry }];

  // Never clobber a config without a copy to fall back to.
  const backup = backupOf(configPath);
  writeFileSync(configPath, insertFormatted(raw, path, value));
  return { path: configPath, replaced, backup };
}

/**
 * Set `path` to `value` in JSONC text, formatting only the new property (in
 * the file's own indentation and line endings) so the user's formatting of
 * every other entry is left exactly as it was.
 */
function insertFormatted(raw: string, path: JSONPath, value: unknown): string {
  const text = applyEdits(raw, modify(raw, path, value, {}));
  const prop = findNodeAtLocation(parseTree(text)!, path)?.parent;
  const parent = prop?.parent;
  if (!prop || !parent?.children) return text;

  // Format from the end of the previous sibling (or the opening brace) to the
  // end of this property (or the closing brace), which fixes the whitespace
  // around the insertion without touching the siblings themselves.
  const siblings = parent.children;
  const i = siblings.indexOf(prop);
  const start = i > 0 ? siblings[i - 1].offset + siblings[i - 1].length : parent.offset;
  const end = i < siblings.length - 1 ? prop.offset + prop.length : parent.offset + parent.length;

  const indent = /^([ \t]+)\S/m.exec(raw)?.[1] ?? "  ";
  const edits = format(text, { offset: start, length: end - start }, {
    insertSpaces: !indent.includes("\t"),
    tabSize: indent.includes("\t") ? 1 : indent.length,
    eol: raw.includes("\r\n") ? "\r\n" : "\n",
  });
  return applyEdits(text, edits);
}

function backupOf(configPath: string): string {
  const backup = `${configPath}.bak`;
  copyFileSync(configPath, backup);
  return backup;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Human label for the restart hint after installing. */
export function clientLabel(client: ClientName): string {
  switch (client) {
    case "cursor":
      return "Cursor";
    case "windsurf":
      return "Windsurf";
    case "cline":
      return "Cline";
    case "zed":
      return "Zed";
    case "vscode":
      return "VS Code";
    default:
      return "Claude Desktop";
  }
}
