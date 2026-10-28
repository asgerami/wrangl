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

test("without an admin token, only local and configured Host names are answered (DNS rebinding)", async () => {
  const app = buildControlPlane(new ServerRegistry(), { allowedHosts: ["mcp.example.com"] });
  try {
    const status = async (host: string) =>
      (await app.inject({ url: "/servers", headers: { host } })).statusCode;
    // A rebinding page keeps its own domain in the Host header.
    assert.equal(await status("attacker.example"), 403);
    assert.equal(await status("attacker.example:4000"), 403);
    for (const host of ["localhost:4000", "127.0.0.1:4000", "[::1]:4000", "app.localhost", "mcp.example.com"]) {
      assert.equal(await status(host), 200, host);
    }
  } finally {
    await app.close();
  }

  // With an admin token, the token is the gate and any Host is fine.
  const authed = buildControlPlane(new ServerRegistry(), { adminToken: "s3cret" });
  try {
    const res = await authed.inject({
      url: "/servers",
      headers: { host: "mcp.anywhere.example", authorization: "Bearer s3cret" },
    });
    assert.equal(res.statusCode, 200);
  } finally {
    await authed.close();
  }
});

test("the tool tester reports a bad argument as 400, and logs reject non-integer queries", async () => {
  const registry = new ServerRegistry();
  const app = buildControlPlane(registry);
  try {
    await app.inject({ method: "POST", url: "/servers", payload: { spec: SPEC, name: "JP" } });
    const res = await app.inject({ method: "POST", url: "/servers/jp/tools/getpost/invoke", payload: {} });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /Missing required parameter "id"/);

    assert.equal((await app.inject({ url: "/servers/jp/logs?limit=lots" })).statusCode, 400);
    assert.equal((await app.inject({ url: "/servers/jp/logs?limit=5" })).statusCode, 200);
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
