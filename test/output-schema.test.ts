import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTools } from "../src/generator/tools.js";
import { toolOutputShape } from "../src/generator/schema.js";
import { createMcpServer } from "../src/runtime/server.js";
import type { OpenAPIDoc } from "../src/parser/openapi.js";

// A tiny inline OpenAPI doc with an object response and an array response.
const DOC: OpenAPIDoc = {
  openapi: "3.0.0",
  info: { title: "t", version: "1" },
  servers: [{ url: "http://example.test" }],
  paths: {
    "/user": {
      get: {
        operationId: "getUser",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { id: { type: "integer" }, name: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    "/users": {
      get: {
        operationId: "listUsers",
        responses: {
          "200": {
            content: { "application/json": { schema: { type: "array", items: { type: "object" } } } },
          },
        },
      },
    },
  },
};

test("object responses get an outputSchema; array responses do not", () => {
  const tools = buildTools(DOC, {});
  const getUser = tools.find((t) => t.name === "getuser")!;
  const listUsers = tools.find((t) => t.name === "listusers")!;
  assert.ok(getUser.outputSchema, "object response should produce an outputSchema");
  assert.equal(listUsers.outputSchema, undefined, "array response should not");
});

test("toolOutputShape accepts arbitrary objects, including {}", () => {
  const tools = buildTools(DOC, {});
  const shape = toolOutputShape(tools.find((t) => t.name === "getuser")!)!;
  assert.ok(shape, "expected an output shape");
  // All top-level props are optional → {} validates; passthrough keeps extras.
  assert.equal(shape.safeParse({}).success, true);
  assert.equal(shape.safeParse({ id: 1, name: "a", extra: true }).success, true);
});

/** Local upstream that returns a JSON object (so structuredContent applies). */
async function jsonServer(payload: unknown): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("tool call returns validated structuredContent for object responses", async () => {
  const upstream = await jsonServer({ id: 7, name: "Ada", extra: "kept" });
  const generated = {
    name: "t",
    version: "1",
    baseUrl: upstream.baseUrl,
    securitySchemes: {},
    tools: buildTools(DOC, {}),
  };

  const server = createMcpServer(generated, { creds: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientTransport);

  try {
    const res = await client.callTool({ name: "getuser", arguments: {} });
    assert.notEqual(res.isError, true);
    // structuredContent should echo the upstream JSON object (passthrough keeps `extra`).
    assert.deepEqual(res.structuredContent, { id: 7, name: "Ada", extra: "kept" });
  } finally {
    await client.close();
    await upstream.close();
  }
});
