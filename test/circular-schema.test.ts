import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTools } from "../src/generator/tools.js";
import type { OpenAPIDoc } from "../src/parser/openapi.js";

/**
 * Dereferenced specs (Stripe, GitHub, ...) inline recursive `$ref`s as genuine
 * circular JS references. buildTools must return tool definitions that are
 * plain, finite, JSON-serializable trees regardless.
 */

function docWithBodySchema(schema: unknown): OpenAPIDoc {
  return {
    openapi: "3.0.0",
    info: { title: "Circular", version: "1" },
    paths: {
      "/x": {
        post: {
          operationId: "x",
          requestBody: { content: { "application/json": { schema: schema as never } } },
          responses: {},
        },
      },
    },
  } as OpenAPIDoc;
}

test("a self-referential body schema serializes and cuts the cycle", () => {
  // node.properties.self === node  (a direct cycle, as dereference produces)
  const node: Record<string, unknown> = { type: "object", properties: {} };
  (node.properties as Record<string, unknown>).self = node;

  const tools = buildTools(docWithBodySchema(node), {});
  assert.equal(tools.length, 1);

  // The whole tool must round-trip through JSON without throwing.
  assert.doesNotThrow(() => JSON.stringify(tools));

  const bodySchema = tools[0].body?.schema as Record<string, unknown>;
  // Top level survives intact...
  assert.equal(bodySchema.type, "object");
  // ...and the back-edge to the same object is collapsed to a permissive {}.
  const props = bodySchema.properties as Record<string, unknown>;
  assert.deepEqual(props.self, {});
});

test("a shared (non-cyclic) subschema is emitted once, not duplicated forever", () => {
  // A node reachable through many parents must not blow up the output.
  const leaf = { type: "string", description: "shared" };
  const wide: Record<string, unknown> = { type: "object", properties: {} };
  const props = wide.properties as Record<string, unknown>;
  for (let i = 0; i < 50; i++) props[`f${i}`] = leaf;

  const tools = buildTools(docWithBodySchema(wide), {});
  const json = JSON.stringify(tools);
  assert.ok(json.length < 5000, `expected a bounded schema, got ${json.length} bytes`);
  // The first occurrence keeps full detail.
  const out = (tools[0].body?.schema as Record<string, unknown>).properties as Record<
    string,
    unknown
  >;
  assert.deepEqual(out.f0, { type: "string", description: "shared" });
});

test("an ordinary acyclic schema passes through unchanged", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["name"],
  };
  const tools = buildTools(docWithBodySchema(schema), {});
  assert.deepEqual(tools[0].body?.schema, schema);
});
