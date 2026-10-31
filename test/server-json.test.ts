import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * server.json is Wrangl's MCP Registry listing. The registry verifies it
 * against the published npm package, so it has to agree with package.json and
 * describe a command line `wrangl generate` actually accepts.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
const npmEntry = server.packages.find((p: { registryType: string }) => p.registryType === "npm");

test("server.json matches package.json: name, package, and version", () => {
  assert.equal(server.name, pkg.mcpName, "the registry requires name === package.json mcpName");
  assert.match(server.name, /^io\.github\.asgerami\//, "GitHub login namespace");
  assert.equal(npmEntry.identifier, pkg.name);
  assert.equal(server.version, pkg.version, "run `npm version`, which syncs server.json");
  assert.equal(npmEntry.version, pkg.version);
  assert.ok(server.description.length <= 100, "the registry rejects descriptions over 100 characters");
});

test("every flag the listing passes exists on `wrangl generate`", () => {
  const help = execFileSync(process.execPath, ["--import", "tsx", join(root, "src", "cli.ts"), "generate", "--help"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  const args = npmEntry.packageArguments as Array<{ type: string; name?: string; value?: string }>;
  assert.equal(args[0].value, "generate");
  for (const arg of args.filter((a) => a.type === "named")) {
    assert.ok(help.includes(arg.name!), `generate --help lists ${arg.name}`);
  }
});

test("a bad WRANGL_TOOL_MODE fails with a clear message", () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, ["--import", "tsx", join(root, "src", "cli.ts"), "generate", "--catalog", "jsonplaceholder"], {
        cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WRANGL_TOOL_MODE: "search" },
      }),
    (err: { stderr?: string }) => /WRANGL_TOOL_MODE must be "endpoints" or "discovery"/.test(err.stderr ?? ""),
  );
});
