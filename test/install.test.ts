import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import {
  installServer,
  clientConfigPath,
  clientConfigKey,
  clientEntry,
  clientLabel,
  isClientName,
  selfCommand,
  buildServerEntry,
} from "../src/clients.js";
import { extractSpecUrls } from "../src/parser/discover.js";

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wrangl-install-"));
}

test("installServer creates the config file when none exists", async () => {
  const path = join(await dir(), "nested", "mcp.json");
  const res = installServer(path, "petstore", { command: "node", args: ["cli.js"] });

  assert.equal(res.replaced, false);
  assert.equal(res.backup, undefined);
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(cfg.mcpServers.petstore, { command: "node", args: ["cli.js"] });
});

test("installServer preserves other servers and backs up the original", async () => {
  const path = join(await dir(), "mcp.json");
  writeFileSync(
    path,
    JSON.stringify({ mcpServers: { other: { command: "x", args: [] } }, unrelated: 1 }),
  );

  const res = installServer(path, "petstore", { command: "node", args: ["cli.js"] });
  assert.equal(res.replaced, false);
  assert.ok(res.backup && existsSync(res.backup), "a backup should be written");

  const cfg = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(cfg.mcpServers.other, "existing server must be preserved");
  assert.ok(cfg.mcpServers.petstore, "new server must be added");
  assert.equal(cfg.unrelated, 1, "unrelated top-level keys must survive");
});

test("installing the same name twice replaces it", async () => {
  const path = join(await dir(), "mcp.json");
  installServer(path, "api", { command: "node", args: ["v1"] });
  const res = installServer(path, "api", { command: "node", args: ["v2"] });

  assert.equal(res.replaced, true);
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(cfg.mcpServers.api.args, ["v2"]);
});

test("a malformed config is refused rather than clobbered", async () => {
  const path = join(await dir(), "mcp.json");
  writeFileSync(path, "{ not json");
  assert.throws(() => installServer(path, "api", { command: "n", args: [] }), /not valid JSON/);
});

test("selfCommand adapts to running from source vs compiled", () => {
  assert.deepEqual(selfCommand("/a/src/cli.ts"), { command: "npx", args: ["tsx", "/a/src/cli.ts"] });
  assert.deepEqual(selfCommand("/a/dist/cli.js"), { command: "node", args: ["/a/dist/cli.js"] });
});

test("selfCommand never points a config into a cache that gets pruned", () => {
  const pkg = { name: "@asgerami/wrangl", version: "1.2.3" };
  const pinned = { command: "npx", args: ["-y", "@asgerami/wrangl@1.2.3"] };
  for (const path of [
    "/home/u/.npm/_npx/9f86d081/node_modules/@asgerami/wrangl/dist/cli.js", // npx
    "C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\9f86d081\\node_modules\\.bin\\wrangl",
    "/home/u/.cache/pnpm/dlx/abc123/node_modules/.bin/wrangl", // pnpm dlx
    join(tmpdir(), "bunx-1000-@asgerami/wrangl@1.2.3/node_modules/.bin/wrangl"), // bunx
  ]) {
    assert.deepEqual(selfCommand(path, pkg), pinned, path);
  }
  // A global or project install is a stable path, so it's used directly.
  assert.deepEqual(selfCommand("/usr/lib/node_modules/@asgerami/wrangl/dist/cli.js", pkg), {
    command: "node",
    args: ["/usr/lib/node_modules/@asgerami/wrangl/dist/cli.js"],
  });
});

test("buildServerEntry launches `generate` with the spec", () => {
  const entry = buildServerEntry("https://api.test/openapi.json", "https://api.test");
  assert.ok(entry.args.includes("generate"));
  assert.ok(entry.args.includes("https://api.test/openapi.json"));
  assert.ok(entry.args.includes("--base-url"));
});

test("buildServerEntry launches a catalog entry by id, not by a path", () => {
  const entry = buildServerEntry({ catalog: "jsonplaceholder" });
  const at = entry.args.indexOf("--catalog");
  assert.equal(entry.args[at + 1], "jsonplaceholder");
  assert.ok(!entry.args.includes("--spec"));
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

type PrintedEntry = { args: string[]; env?: Record<string, string> };

/** Run the CLI from source and parse the config block `--print` emits. */
function printedEntry(...args: string[]): PrintedEntry {
  const out = execFileSync(
    process.execPath,
    ["--import", "tsx", join(root, "src", "cli.ts"), ...args, "--print"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const servers = JSON.parse(out).mcpServers as Record<string, PrintedEntry>;
  return Object.values(servers)[0];
}

test("install --env puts the key in the client config, where the server can see it", () => {
  const { env } = printedEntry("add", "jsonplaceholder", "--env", "WRANGL_API_KEY=k-123");
  assert.deepEqual(env, { WRANGL_API_KEY: "k-123" });
});

test("a malformed --env flag fails without echoing what was passed", () => {
  assert.throws(
    () => printedEntry("add", "jsonplaceholder", "--env", "sk-live-secret"),
    (err: { stderr?: string }) =>
      /Expected KEY=value/.test(err.stderr ?? "") && !(err.stderr ?? "").includes("sk-live-secret"),
  );
});

test("install records a relative spec path as absolute", () => {
  const { args } = printedEntry("install", "examples/jsonplaceholder.yaml");
  assert.equal(args[args.indexOf("--spec") + 1], join(root, "examples", "jsonplaceholder.yaml"));
});

test("add records a catalog id so a bundled spec is found at launch", () => {
  const { args } = printedEntry("add", "jsonplaceholder");
  assert.equal(args[args.indexOf("--catalog") + 1], "jsonplaceholder");
  assert.ok(!args.includes("--spec"), "no path into the package's install directory");
});

test("buildServerEntry forwards include/exclude filter flags", () => {
  const entry = buildServerEntry("https://api.test/openapi.json", {
    include: ["repos*", "issues*"],
    exclude: ["*webhook*"],
  });
  assert.deepEqual(
    entry.args.filter((_, i, a) => a[i - 1] === "--include"),
    ["repos*", "issues*"],
  );
  assert.deepEqual(
    entry.args.filter((_, i, a) => a[i - 1] === "--exclude"),
    ["*webhook*"],
  );
});

test("clientConfigPath points at the right file per client", () => {
  assert.match(clientConfigPath("cursor", "/home/u"), /\.cursor[/\\]mcp\.json$/);
  assert.match(clientConfigPath("claude", "/home/u"), /[Cc]laude/);
  assert.match(clientConfigPath("windsurf", "/home/u"), /windsurf[/\\]mcp_config\.json$/);
  assert.match(clientConfigPath("cline", "/home/u"), /cline_mcp_settings\.json$/);
  assert.match(clientConfigPath("zed", "/home/u"), /zed[/\\]settings\.json$/);
  assert.match(
    clientConfigPath("vscode", "/home/u", "/proj"),
    /[/\\]proj[/\\]\.vscode[/\\]mcp\.json$/,
  );
});

test("clientConfigKey and clientEntry shape entries per client", () => {
  const entry = { command: "node", args: ["cli.js"] };

  assert.equal(clientConfigKey("claude"), "mcpServers");
  assert.equal(clientConfigKey("windsurf"), "mcpServers");
  assert.equal(clientConfigKey("cline"), "mcpServers");
  assert.deepEqual(clientEntry("claude", entry), entry);

  assert.equal(clientConfigKey("vscode"), "servers");
  assert.deepEqual(clientEntry("vscode", entry), { type: "stdio", command: "node", args: ["cli.js"] });

  assert.equal(clientConfigKey("zed"), "context_servers");
  assert.deepEqual(clientEntry("zed", entry), { source: "custom", command: "node", args: ["cli.js"] });

  // Every client's shape carries the server's env through.
  const withEnv = { ...entry, env: { WRANGL_API_KEY: "k" } };
  for (const client of ["claude", "vscode", "zed"] as const) {
    assert.deepEqual(clientEntry(client, withEnv).env, { WRANGL_API_KEY: "k" }, client);
  }
});

test("isClientName validates against the supported set", () => {
  assert.equal(isClientName("vscode"), true);
  assert.equal(isClientName("windsurf"), true);
  assert.equal(isClientName("notaclient"), false);
});

test("clientLabel names every supported client", () => {
  assert.equal(clientLabel("cursor"), "Cursor");
  assert.equal(clientLabel("windsurf"), "Windsurf");
  assert.equal(clientLabel("cline"), "Cline");
  assert.equal(clientLabel("zed"), "Zed");
  assert.equal(clientLabel("vscode"), "VS Code");
  assert.equal(clientLabel("claude"), "Claude Desktop");
});

test("installServer supports a custom top-level config key, preserving other settings", async () => {
  const path = join(await dir(), "settings.json");
  writeFileSync(path, JSON.stringify({ unrelated_setting: true }));

  const res = installServer(
    path,
    "petstore",
    { source: "custom", command: "node", args: ["cli.js"] },
    "context_servers",
  );

  assert.equal(res.replaced, false);
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(cfg.context_servers.petstore, {
    source: "custom",
    command: "node",
    args: ["cli.js"],
  });
  assert.equal(cfg.unrelated_setting, true, "unrelated settings must survive");
});

test("installServer edits a commented JSONC config in place (Zed, VS Code)", async () => {
  const path = join(await dir(), "settings.json");
  const original = [
    "// Zed settings",
    "//",
    "// For information on how to configure Zed, see the Zed docs.",
    "{",
    '    "theme": "One Dark", // keep this',
    "    /* fonts */",
    '    "buffer_font_size": 15,',
    '    "context_servers": {',
    '        "other": { "source": "custom", "command": "x", "args": [] },',
    "    },",
    "}",
    "",
  ].join("\n");
  writeFileSync(path, original);

  const entry = { source: "custom", command: "node", args: ["cli.js"] };
  const res = installServer(path, "petstore", entry, "context_servers");
  assert.equal(res.replaced, false);
  assert.equal(readFileSync(res.backup!, "utf8"), original, "backup is the untouched original");

  const written = readFileSync(path, "utf8");
  for (const comment of ["// Zed settings", "// keep this", "/* fonts */"]) {
    assert.ok(written.includes(comment), `comment survives: ${comment}`);
  }
  assert.match(written, /\n {8}"petstore": \{/, "new entry follows the file's 4-space indent");
  assert.ok(
    written.includes('        "other": { "source": "custom", "command": "x", "args": [] },\n'),
    "an existing entry keeps its own formatting",
  );
  const cfg = parseJsonc(written, [], { allowTrailingComma: true });
  assert.equal(cfg.theme, "One Dark");
  assert.equal(cfg.buffer_font_size, 15);
  assert.ok(cfg.context_servers.other, "existing server kept");
  assert.deepEqual(cfg.context_servers.petstore, entry);

  // Reinstalling replaces only that entry and still keeps the comments.
  const again = installServer(path, "petstore", { ...entry, args: ["v2"] }, "context_servers");
  assert.equal(again.replaced, true);
  const rewritten = readFileSync(path, "utf8");
  assert.ok(rewritten.includes("// keep this"));
  assert.deepEqual(parseJsonc(rewritten, [], { allowTrailingComma: true }).context_servers.petstore.args, ["v2"]);
});

test("extractSpecUrls finds the spec a docs page references", () => {
  const swaggerInit = `window.ui = SwaggerUIBundle({ url: "https://petstore3.swagger.io/api/v3/openapi.json", dom_id: '#ui' });`;
  assert.deepEqual(extractSpecUrls(swaggerInit, "https://petstore3.swagger.io/swagger-initializer.js"), [
    "https://petstore3.swagger.io/api/v3/openapi.json",
  ]);

  // Relative references resolve against the page URL.
  const html = `<script>const spec = './v1/openapi.yaml';</script>`;
  assert.deepEqual(extractSpecUrls(html, "https://api.test/docs"), [
    "https://api.test/v1/openapi.yaml",
  ]);

  assert.deepEqual(extractSpecUrls("<html>nothing here</html>", "https://api.test/"), []);
});
