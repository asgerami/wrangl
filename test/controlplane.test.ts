import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer as createHttpServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { ServerRegistry } from "../src/controlplane/registry.js";
import { buildControlPlane } from "../src/controlplane/api.js";
import { LogStore } from "../src/runtime/logstore.js";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = join(here, "..", "examples", "jsonplaceholder.yaml");

function app() {
  const registry = new ServerRegistry({ logStore: LogStore.open(":memory:") });
  return { registry, app: buildControlPlane(registry) };
}

async function createServer(a: ReturnType<typeof buildControlPlane>, payload: object) {
  return a.inject({ method: "POST", url: "/servers", payload });
}

test("POST /servers creates a server from a spec", async () => {
  const { app: a } = app();
  const res = await createServer(a, { spec: SPEC, name: "JP" });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.slug, "jp");
  assert.equal(body.toolCount, 4);
  assert.equal(body.mcpPath, "/servers/jp/mcp");
  await a.close();
});

test("POST /servers without a spec is a 400", async () => {
  const { app: a } = app();
  const res = await createServer(a, { name: "x" });
  assert.equal(res.statusCode, 400);
  await a.close();
});

test("GET /servers lists, /servers/:id/tools returns tools", async () => {
  const { app: a } = app();
  await createServer(a, { spec: SPEC });
  const list = (await a.inject({ url: "/servers" })).json();
  assert.equal(list.length, 1);
  const id = list[0].id;

  const tools = (await a.inject({ url: `/servers/${id}/tools` })).json();
  assert.equal(tools.length, 4);
  assert.ok(tools.every((t: { name: string; method: string }) => t.name && t.method));
  await a.close();
});

test("unknown server returns 404", async () => {
  const { app: a } = app();
  const res = await a.inject({ url: "/servers/nope" });
  assert.equal(res.statusCode, 404);
  await a.close();
});

test("credentials endpoint validates and accepts", async () => {
  const { app: a } = app();
  await createServer(a, { spec: SPEC });
  const id = (await a.inject({ url: "/servers" })).json()[0].id;

  const bad = await a.inject({ method: "POST", url: `/servers/${id}/credentials`, payload: { scheme: "x" } });
  assert.equal(bad.statusCode, 400);

  const ok = await a.inject({
    method: "POST",
    url: `/servers/${id}/credentials`,
    payload: { scheme: "bearerAuth", value: "tok" },
  });
  assert.equal(ok.statusCode, 204);
  await a.close();
});

test("regenerate on an unchanged spec reports no changes", async () => {
  const { app: a } = app();
  await createServer(a, { spec: SPEC });
  const id = (await a.inject({ url: "/servers" })).json()[0].id;

  const res = await a.inject({ method: "POST", url: `/servers/${id}/regenerate` });
  assert.equal(res.statusCode, 200);
  const { diff } = res.json();
  assert.deepEqual([diff.added.length, diff.removed.length, diff.changed.length], [0, 0, 0]);
  await a.close();
});

test("DELETE removes a server", async () => {
  const { app: a } = app();
  await createServer(a, { spec: SPEC });
  const id = (await a.inject({ url: "/servers" })).json()[0].id;

  assert.equal((await a.inject({ method: "DELETE", url: `/servers/${id}` })).statusCode, 204);
  assert.equal((await a.inject({ url: `/servers/${id}` })).statusCode, 404);
  await a.close();
});

test("server detail exposes security schemes for the credentials form", async () => {
  const { app: a } = app();
  await createServer(a, { spec: SPEC });
  const id = (await a.inject({ url: "/servers" })).json()[0].id;
  const detail = (await a.inject({ url: `/servers/${id}` })).json();
  assert.ok(Array.isArray(detail.securitySchemes));
  // The JSONPlaceholder example declares no security schemes.
  assert.equal(detail.securitySchemes.length, 0);
  await a.close();
});

test("POST /servers with discover finds and creates from a base URL", async () => {
  // A local upstream that serves an OpenAPI spec at a well-known path.
  const spec = JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Discovered API", version: "1" },
    servers: [{ url: "http://example.test" }],
    paths: { "/ping": { get: { operationId: "ping", responses: {} } } },
  });
  const upstream: Server = createHttpServer((req, res) => {
    if (req.url === "/openapi.json") {
      res.writeHead(200, { "content-type": "application/json" }).end(spec);
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = (upstream.address() as AddressInfo).port;

  const { app: a } = app();
  try {
    const res = await createServer(a, { discover: `http://127.0.0.1:${port}` });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().name, "Discovered API");
    assert.equal(res.json().toolCount, 1);
  } finally {
    await a.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("POST /servers without spec or discover is a 400", async () => {
  const { app: a } = app();
  const res = await createServer(a, { name: "x", baseUrl: "http://y" });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /spec.*discover/i);
  await a.close();
});

test("logs endpoint returns an array for a known server", async () => {
  const { app: a } = app();
  await createServer(a, { spec: SPEC });
  const id = (await a.inject({ url: "/servers" })).json()[0].id;
  const res = await a.inject({ url: `/servers/${id}/logs` });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json()));
  await a.close();
});
