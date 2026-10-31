#!/usr/bin/env node
/**
 * Copy package.json's version into server.json (the MCP Registry listing),
 * at the top level and on the npm package entry. Runs as npm's `version`
 * hook, so `npm version 0.6.0` keeps the two in step.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const path = join(root, "server.json");
const server = JSON.parse(readFileSync(path, "utf8"));

server.version = version;
for (const pkg of server.packages ?? []) {
  if (pkg.registryType === "npm") pkg.version = version;
}
writeFileSync(path, JSON.stringify(server, null, 2) + "\n");
console.log(`server.json -> ${version}`);
