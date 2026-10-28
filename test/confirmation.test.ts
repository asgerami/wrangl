import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { createReloadableServer } from "../src/runtime/server.js";
import type { GeneratedServer, ToolDef } from "../src/types.js";

// Deterministic key so requestState verification doesn't depend on the
// random-per-process fallback (and to silence its startup warning).
process.env.WRANGL_SECRET_KEY = "test-secret-key-at-least-32-bytes-long-xx";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
};

function deleteTool(): ToolDef {
  return {
    name: "deleteitem",
    description: "Delete an item.",
    method: "DELETE",
    pathTemplate: "/items/{id}",
    params: [{ name: "id", sourceName: "id", location: "path", required: true, style: "simple", explode: false, schema: { type: "string" } }],
    security: [],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

async function call(handler: McpHttpHandler, params: Record<string, unknown>, id = 1) {
  const res = await handler.fetch(
    new Request("http://test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": String(params.name),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params }),
    }),
  );
  return res.json() as Promise<any>;
}

test("a destructive tool requires confirmation, then executes once confirmed", async () => {
  let hits = 0;
  const upstream = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  const port = await listen(upstream);

  const generated: GeneratedServer = {
    name: "test",
    version: "1.0.0",
    baseUrl: `http://127.0.0.1:${port}`,
    tools: [deleteTool()],
    securitySchemes: {},
  };
  const { server } = createReloadableServer(generated, { creds: {} });
  const handler = createMcpHandler(() => server, { legacy: "stateless" });

  try {
    // First call: no confirmation yet -> input_required, nothing executed.
    const first = await call(handler, { name: "deleteitem", arguments: { id: "42" }, _meta: META });
    assert.equal(first.result.resultType, "input_required");
    assert.ok(first.result.inputRequests.confirm, "expected an elicitation request for confirmation");
    assert.equal(first.result.inputRequests.confirm.method, "elicitation/create");
    assert.ok(first.result.requestState, "expected a signed requestState");
    assert.equal(hits, 0, "must not call upstream before confirmation");

    // Retry with acceptance + the echoed requestState -> executes for real.
    const second = await call(handler, {
      name: "deleteitem",
      arguments: { id: "42" },
      inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
      requestState: first.result.requestState,
      _meta: META,
    }, 2);
    assert.equal(second.result.resultType, "complete");
    assert.equal(second.result.isError, false);
    assert.equal(hits, 1, "must call upstream exactly once after confirmation");
  } finally {
    upstream.close();
    await handler.close();
  }
});

test("a requestState minted for different arguments is rejected (re-prompts, does not execute)", async () => {
  let hits = 0;
  const upstream = createServer((_req, res) => {
    hits++;
    res.writeHead(200).end("{}");
  });
  const port = await listen(upstream);
  const generated: GeneratedServer = {
    name: "test", version: "1.0.0", baseUrl: `http://127.0.0.1:${port}`,
    tools: [deleteTool()], securitySchemes: {},
  };
  const { server } = createReloadableServer(generated, { creds: {} });
  const handler = createMcpHandler(() => server, { legacy: "stateless" });

  try {
    const first = await call(handler, { name: "deleteitem", arguments: { id: "42" }, _meta: META });
    const state = first.result.requestState;

    // Same requestState, but a DIFFERENT id than what it was minted for.
    const second = await call(handler, {
      name: "deleteitem",
      arguments: { id: "99" },
      inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
      requestState: state,
      _meta: META,
    }, 2);
    assert.equal(second.result.resultType, "input_required");
    assert.equal(hits, 0, "must not execute when requestState doesn't match the call");
  } finally {
    upstream.close();
    await handler.close();
  }
});

test("a tampered requestState is rejected with -32602, not silently accepted", async () => {
  const generated: GeneratedServer = {
    name: "test", version: "1.0.0", baseUrl: "http://127.0.0.1:1",
    tools: [deleteTool()], securitySchemes: {},
  };
  const { server } = createReloadableServer(generated, { creds: {} });
  const handler = createMcpHandler(() => server, { legacy: "stateless" });

  try {
    const first = await call(handler, { name: "deleteitem", arguments: { id: "42" }, _meta: META });
    const state: string = first.result.requestState;
    // Flip a character in the middle of the MAC segment.
    const parts = state.split(".");
    const mac = parts[2];
    const flipped = mac[10] === "A" ? "B" : "A";
    parts[2] = mac.slice(0, 10) + flipped + mac.slice(11);
    const tampered = parts.join(".");

    const second = await call(handler, {
      name: "deleteitem",
      arguments: { id: "42" },
      inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
      requestState: tampered,
      _meta: META,
    }, 2);
    assert.equal(second.error?.code, -32602);
    assert.match(second.error?.message ?? "", /Invalid or expired requestState/);
  } finally {
    await handler.close();
  }
});

test("declining the confirmation fails the call instead of re-prompting forever", async () => {
  const generated: GeneratedServer = {
    name: "test", version: "1.0.0", baseUrl: "http://127.0.0.1:1",
    tools: [deleteTool()], securitySchemes: {},
  };
  const { server } = createReloadableServer(generated, { creds: {} });
  const handler = createMcpHandler(() => server, { legacy: "stateless" });

  try {
    const first = await call(handler, { name: "deleteitem", arguments: { id: "42" }, _meta: META });
    const second = await call(handler, {
      name: "deleteitem",
      arguments: { id: "42" },
      inputResponses: { confirm: { action: "decline" } },
      requestState: first.result.requestState,
      _meta: META,
    }, 2);
    assert.equal(second.result.resultType, "complete");
    assert.equal(second.result.isError, true);
    assert.match(second.result.content[0].text, /declined/i);
  } finally {
    await handler.close();
  }
});

test("non-destructive tools are never gated behind confirmation", async () => {
  const upstream = createServer((_req, res) => res.writeHead(200).end("{}"));
  const port = await listen(upstream);
  const getTool: ToolDef = {
    name: "getitem",
    description: "Get an item.",
    method: "GET",
    pathTemplate: "/items/{id}",
    params: [{ name: "id", sourceName: "id", location: "path", required: true, style: "simple", explode: false, schema: { type: "string" } }],
    security: [],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  };
  const generated: GeneratedServer = {
    name: "test", version: "1.0.0", baseUrl: `http://127.0.0.1:${port}`,
    tools: [getTool], securitySchemes: {},
  };
  const { server } = createReloadableServer(generated, { creds: {} });
  const handler = createMcpHandler(() => server, { legacy: "stateless" });

  try {
    const result = await call(handler, { name: "getitem", arguments: { id: "1" }, _meta: META });
    assert.equal(result.result.resultType, "complete");
  } finally {
    upstream.close();
    await handler.close();
  }
});

test("tools/list carries the modern wire shape: resultType, cache fields, and annotations", async () => {
  const generated: GeneratedServer = {
    name: "test", version: "1.0.0", baseUrl: "http://127.0.0.1:1",
    tools: [deleteTool()], securitySchemes: {},
  };
  const { server } = createReloadableServer(generated, { creds: {} });
  const handler = createMcpHandler(() => server, { legacy: "stateless" });

  try {
    const res = await handler.fetch(
      new Request("http://test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/list",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } }),
      }),
    );
    const body = await res.json();
    assert.equal(body.result.resultType, "complete");
    assert.equal(typeof body.result.ttlMs, "number");
    assert.ok(["public", "private"].includes(body.result.cacheScope));
    assert.deepEqual(body.result.tools[0].annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  } finally {
    await handler.close();
  }
});

test("a raw WRANGL_SECRET_KEY is not reused as-is for signing confirmations", async () => {
  const { deriveConfirmationKey } = await import("../src/runtime/confirmation.js");
  const hex = "ab".repeat(32); // a raw key, which the vault uses directly
  const key = deriveConfirmationKey(hex);
  assert.equal(key.length, 32);
  assert.notDeepEqual(key, Buffer.from(hex, "hex"), "must not share the vault's key bytes");
  assert.deepEqual(deriveConfirmationKey(hex), key, "deterministic, so replicas agree");
});
