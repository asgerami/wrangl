import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { discoverSpec, isSpecDocument } from "../src/parser/discover.js";

const MINIMAL_SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Discovered", version: "1" },
  servers: [{ url: "http://example.test" }],
  paths: { "/ping": { get: { operationId: "ping", responses: {} } } },
});

/** Serve `MINIMAL_SPEC` only at the given path; 404 everywhere else. */
async function specServer(specPath: string | null): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (specPath && req.url === specPath) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(MINIMAL_SPEC);
    } else {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

test("isSpecDocument recognizes JSON and YAML specs, rejects others", () => {
  assert.equal(isSpecDocument('{"openapi":"3.0.0"}'), true);
  assert.equal(isSpecDocument('{"swagger":"2.0"}'), true);
  assert.equal(isSpecDocument("openapi: 3.0.0\ninfo: {}"), true);
  assert.equal(isSpecDocument('{"not":"a spec"}'), false);
  assert.equal(isSpecDocument("<html>hi</html>"), false);
  assert.equal(isSpecDocument("just text"), false);
});

test("discoverSpec finds a spec at a well-known path", async () => {
  const srv = await specServer("/openapi.json");
  try {
    const found = await discoverSpec(srv.base, { timeoutMs: 3000 });
    assert.ok(found);
    assert.equal(found?.specUrl, srv.base + "/openapi.json");
  } finally {
    await srv.close();
  }
});

test("discoverSpec finds a spec at an alternate path", async () => {
  const srv = await specServer("/v3/api-docs");
  try {
    const found = await discoverSpec(srv.base, { timeoutMs: 3000 });
    assert.equal(found?.specUrl, srv.base + "/v3/api-docs");
  } finally {
    await srv.close();
  }
});

test("discoverSpec returns null when nothing serves a spec", async () => {
  const srv = await specServer(null);
  try {
    const found = await discoverSpec(srv.base, { timeoutMs: 2000 });
    assert.equal(found, null);
  } finally {
    await srv.close();
  }
});
