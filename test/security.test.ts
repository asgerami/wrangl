import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AddressInfo } from "node:net";
import { ServerRegistry } from "../src/controlplane/registry.js";
import { buildControlPlane } from "../src/controlplane/api.js";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = join(here, "..", "examples", "jsonplaceholder.yaml");

test("admin token gates the management API but not public routes", async () => {
  const app = buildControlPlane(new ServerRegistry(), { adminToken: "s3cret" });
  try {
    // Public routes need no token.
    assert.equal((await app.inject({ url: "/health" })).statusCode, 200);
    assert.equal((await app.inject({ url: "/" })).statusCode, 200);

    // Management routes require the token.
    assert.equal((await app.inject({ url: "/servers" })).statusCode, 401);
    const ok = await app.inject({ url: "/servers", headers: { authorization: "Bearer s3cret" } });
    assert.equal(ok.statusCode, 200);

    const badPost = await app.inject({ method: "POST", url: "/servers", payload: { spec: SPEC } });
    assert.equal(badPost.statusCode, 401);
    const goodPost = await app.inject({
      method: "POST", url: "/servers",
      headers: { authorization: "Bearer s3cret" }, payload: { spec: SPEC },
    });
    assert.equal(goodPost.statusCode, 201);
  } finally {
    await app.close();
  }
});

test("hosted MCP endpoint requires the per-server token", async () => {
  const registry = new ServerRegistry();
  const app = buildControlPlane(registry);
  try {
    const created = await app.inject({ method: "POST", url: "/servers", payload: { spec: SPEC } });
    const { slug, mcpToken } = created.json();
    assert.ok(mcpToken);

    // No token / wrong token → 401 (checked before the transport hijacks).
    assert.equal((await app.inject({ url: `/servers/${slug}/mcp` })).statusCode, 401);
    const wrong = await app.inject({
      url: `/servers/${slug}/mcp`, headers: { authorization: "Bearer nope" },
    });
    assert.equal(wrong.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("per-server rate limit returns 429 once exceeded", async () => {
  const registry = new ServerRegistry();
  const app = buildControlPlane(registry, { rateLimitPerMin: 1 });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  try {
    const created = await app.inject({ method: "POST", url: "/servers", payload: { spec: SPEC } });
    const { slug, mcpToken } = created.json();
    const url = `http://127.0.0.1:${port}/servers/${slug}/mcp`;
    const headers = { authorization: `Bearer ${mcpToken}`, "content-type": "application/json" };

    // First request is allowed (the MCP transport itself may reject the body,
    // but it passes the rate gate); the second is rate-limited.
    await fetch(url, { method: "POST", headers, body: "{}" }).catch(() => {});
    const second = await fetch(url, { method: "POST", headers, body: "{}" });
    assert.equal(second.status, 429);
  } finally {
    await app.close();
  }
});
