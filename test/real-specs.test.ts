import { test } from "node:test";
import assert from "node:assert/strict";
import { ingest } from "../src/parser/openapi.js";
import { toolInputShape, toolOutputShape } from "../src/generator/schema.js";

/**
 * Robustness sweep against large, real-world OpenAPI specs. These hit the
 * network, so they're skipped under MCPIFY_SKIP_NETWORK=1. The goal is not
 * exact counts but that ingestion + schema generation survive messy real specs
 * without throwing, produce unique tool names, and yield valid Zod shapes.
 */

const SPECS: Array<{ name: string; url: string; minTools: number }> = [
  {
    name: "Petstore (OpenAPI example)",
    url: "https://petstore3.swagger.io/api/v3/openapi.json",
    minTools: 10,
  },
  {
    name: "GitHub API (large, complex)",
    url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    minTools: 500,
  },
];

const skip = process.env.MCPIFY_SKIP_NETWORK === "1";

for (const spec of SPECS) {
  test(
    `ingests ${spec.name} without throwing`,
    { skip, timeout: 120_000 },
    async () => {
      const gen = await ingest(spec.url);
      assert.ok(
        gen.tools.length >= spec.minTools,
        `expected ≥ ${spec.minTools} tools, got ${gen.tools.length}`,
      );

      // Tool names must be unique and MCP-safe (letters/digits/underscores).
      const names = new Set<string>();
      for (const tool of gen.tools) {
        assert.match(tool.name, /^[a-z0-9_]+$/, `bad tool name: ${tool.name}`);
        assert.equal(names.has(tool.name), false, `duplicate name: ${tool.name}`);
        names.add(tool.name);
      }

      // Every tool must yield a usable input shape and (when present) an
      // output shape that accepts an empty object — never throw building them.
      for (const tool of gen.tools) {
        const input = toolInputShape(tool);
        assert.equal(typeof input, "object");
        const output = toolOutputShape(tool);
        if (output) assert.equal(output.safeParse({}).success, true);
      }
    },
  );
}
