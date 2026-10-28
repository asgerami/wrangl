#!/usr/bin/env node
/**
 * Re-count the tools each catalog entry generates and update the `tools`
 * numbers `wrangl catalog` shows, which drift as upstream specs grow.
 *
 *   npm run build && node scripts/catalog-counts.mjs          # report
 *   npm run build && node scripts/catalog-counts.mjs --write  # update manifest
 *
 * Entries whose spec can't be fetched are reported and left unchanged.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ingest, findCatalogEntry, defaultManifestPath } = await import(join(root, "dist", "index.js"));

const manifestPath = defaultManifestPath();
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
let changed = 0;

for (const entry of manifest.servers) {
  const { spec } = findCatalogEntry(entry.id, manifestPath);
  try {
    const { tools } = await ingest(spec, { baseUrl: entry.baseUrl });
    const note = tools.length === entry.tools ? "" : `  (was ${entry.tools})`;
    console.log(`${entry.id.padEnd(16)} ${String(tools.length).padStart(5)} tools${note}`);
    if (tools.length !== entry.tools) {
      entry.tools = tools.length;
      changed++;
    }
  } catch (err) {
    console.log(`${entry.id.padEnd(16)}     ? ${err instanceof Error ? err.message : err}`);
  }
}

if (process.argv.includes("--write") && changed > 0) {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nUpdated ${changed} count(s) in ${manifestPath}`);
}
