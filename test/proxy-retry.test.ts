import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { executeTool } from "../src/runtime/proxy.js";
import type { ProxyContext, RequestLog } from "../src/runtime/proxy.js";
import type { ToolDef } from "../src/types.js";

function tool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "t",
    description: "",
    method: "GET",
    pathTemplate: "/",
    params: [],
    body: undefined,
    security: [],
    ...overrides,
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

test("a GET retries a transient 503 and succeeds", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    if (hits < 3) res.writeHead(503).end("try again");
    else res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  const port = await listen(server);

  try {
    const ctx: ProxyContext = {
      baseUrl: `http://127.0.0.1:${port}`,
      schemes: {},
      creds: {},
      maxRetries: 2,
    };
    const result = await executeTool(tool(), {}, ctx);
    assert.equal(result.statusCode, 200);
    assert.equal(hits, 3, "expected two retries before success");
  } finally {
    server.close();
  }
});

test("a POST does not retry a 503 — it might have already run server-side", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(503).end("try again");
  });
  const port = await listen(server);

  try {
    const ctx: ProxyContext = { baseUrl: `http://127.0.0.1:${port}`, schemes: {}, creds: {}, maxRetries: 2 };
    const result = await executeTool(tool({ method: "POST" }), {}, ctx);
    assert.equal(result.statusCode, 503);
    assert.equal(hits, 1, "POST must not be retried automatically");
  } finally {
    server.close();
  }
});

test("retries are exhausted and the last response is returned as-is", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(502).end("bad gateway");
  });
  const port = await listen(server);

  try {
    const ctx: ProxyContext = { baseUrl: `http://127.0.0.1:${port}`, schemes: {}, creds: {}, maxRetries: 2 };
    const result = await executeTool(tool(), {}, ctx);
    assert.equal(result.statusCode, 502);
    assert.equal(hits, 3, "1 initial attempt + 2 retries");
  } finally {
    server.close();
  }
});

test("maxRetries: 0 disables retrying entirely", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(503).end("try again");
  });
  const port = await listen(server);

  try {
    const ctx: ProxyContext = { baseUrl: `http://127.0.0.1:${port}`, schemes: {}, creds: {}, maxRetries: 0 };
    const result = await executeTool(tool(), {}, ctx);
    assert.equal(result.statusCode, 503);
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});

test("a network error is retried and eventually throws a clear error", async () => {
  // Nothing listens on this port.
  const ctx: ProxyContext = { baseUrl: "http://127.0.0.1:1", schemes: {}, creds: {}, maxRetries: 1 };
  await assert.rejects(
    () => executeTool(tool(), {}, ctx),
    /Upstream request failed/,
  );
});

test("a POST or PATCH is not re-sent after a network error — it may have reached the server", async () => {
  let hits = 0;
  // Accept the request, then drop the connection before responding: the write
  // may have run upstream even though the client only sees a network error.
  const server = createServer((req) => {
    hits++;
    req.socket.destroy();
  });
  const port = await listen(server);

  try {
    const ctx: ProxyContext = { baseUrl: `http://127.0.0.1:${port}`, schemes: {}, creds: {}, maxRetries: 2 };
    for (const method of ["POST", "PATCH"]) {
      hits = 0;
      await assert.rejects(() => executeTool(tool({ method }), {}, ctx), /Upstream request failed/);
      assert.equal(hits, 1, `${method} must not be re-sent after a network error`);
    }
  } finally {
    server.close();
  }
});

test("an invalid argument fails at once — no retries, no upstream call, no 'upstream' label", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(200).end("{}");
  });
  const port = await listen(server);

  try {
    const logs: RequestLog[] = [];
    const ctx: ProxyContext = {
      baseUrl: `http://127.0.0.1:${port}`,
      schemes: {},
      creds: {},
      maxRetries: 2,
      onLog: (entry) => logs.push(entry),
    };
    const needsQ = tool({
      params: [
        { name: "q", sourceName: "q", location: "query", required: true, schema: { type: "string" }, style: "form", explode: true },
      ],
    });
    await assert.rejects(() => executeTool(needsQ, {}, ctx), {
      message: 'Missing required parameter "q".',
    });
    assert.equal(hits, 0, "a request that can't be built must never be sent");
    assert.equal(logs.length, 1, "the rejected call is still logged once");
    assert.equal(logs[0].error, 'Missing required parameter "q".');
  } finally {
    server.close();
  }
});

test("a failed request is logged without its query-string credentials", async () => {
  const logs: RequestLog[] = [];
  // Nothing listens on this port.
  const ctx: ProxyContext = {
    baseUrl: "http://127.0.0.1:1",
    schemes: { key: { type: "apiKey", name: "key", in: "query", paramName: "api_key" } },
    creds: { key: "sk-secret" },
    maxRetries: 0,
    onLog: (entry) => logs.push(entry),
  };
  await assert.rejects(() => executeTool(tool({ security: ["key"] }), {}, ctx), /Upstream request failed/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].url, "http://127.0.0.1:1/");
  assert.ok(!JSON.stringify(logs).includes("sk-secret"));
});

test("a hanging upstream times out — retried for a GET, never re-sent for a POST", async () => {
  let hits = 0;
  // Accept every request and never answer.
  const server = createServer(() => {
    hits++;
  });
  const port = await listen(server);

  try {
    const ctx: ProxyContext = { baseUrl: `http://127.0.0.1:${port}`, schemes: {}, creds: {}, maxRetries: 1, timeoutMs: 50 };
    for (const [method, expectedHits] of [["GET", 2], ["POST", 1]] as const) {
      hits = 0;
      await assert.rejects(
        () => executeTool(tool({ method }), {}, ctx),
        { message: "Upstream request failed: timed out after 50ms" },
      );
      assert.equal(hits, expectedHits, `${method} attempts`);
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("the timeout also covers a response body that stalls after the headers", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"partial":'); // ...and never finish
  });
  const port = await listen(server);

  try {
    const ctx: ProxyContext = { baseUrl: `http://127.0.0.1:${port}`, schemes: {}, creds: {}, maxRetries: 0, timeoutMs: 50 };
    await assert.rejects(() => executeTool(tool(), {}, ctx), /timed out after 50ms/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("a 4xx response is never retried", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(404).end("not found");
  });
  const port = await listen(server);

  try {
    const ctx: ProxyContext = { baseUrl: `http://127.0.0.1:${port}`, schemes: {}, creds: {}, maxRetries: 2 };
    const result = await executeTool(tool(), {}, ctx);
    assert.equal(result.statusCode, 404);
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});
