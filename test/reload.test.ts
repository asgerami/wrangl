import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createReloadableServer } from "../src/runtime/server.js";
import type { GeneratedServer, ToolDef } from "../src/types.js";

function tool(name: string, path: string): ToolDef {
  return {
    name,
    description: `Call ${path}`,
    method: "GET",
    pathTemplate: path,
    params: [],
    body: undefined,
    security: [],
  };
}

function gen(baseUrl: string, tools: ToolDef[]): GeneratedServer {
  return { name: "t", version: "1", baseUrl, securitySchemes: {}, tools };
}

async function echoServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

test("reload hot-swaps tools on a live MCP connection", async () => {
  const upstream = await echoServer();
  const initial = gen(upstream.baseUrl, [tool("alpha", "/a"), tool("beta", "/b")]);
  const reloadable = createReloadableServer(initial, { creds: {} });

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await reloadable.server.connect(serverT);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(clientT);

  try {
    let names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["alpha", "beta"]);

    // Reload: drop beta, keep alpha, add gamma.
    const diff = reloadable.reload(
      gen(upstream.baseUrl, [tool("alpha", "/a"), tool("gamma", "/g")]),
    );
    assert.deepEqual(diff.added, ["gamma"]);
    assert.deepEqual(diff.removed, ["beta"]);

    // The client sees the new tool list (server emitted list_changed).
    names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["alpha", "gamma"]);

    // And the newly added tool actually works against the upstream.
    const res = await client.callTool({ name: "gamma", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    assert.match(text, /HTTP 200/);
    assert.match(text, /"path":"\/g"/);
  } finally {
    await client.close();
    await upstream.close();
  }
});

test("reload updates a changed tool's endpoint", async () => {
  const upstream = await echoServer();
  const reloadable = createReloadableServer(
    gen(upstream.baseUrl, [tool("thing", "/old")]),
    { creds: {} },
  );
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await reloadable.server.connect(serverT);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(clientT);

  try {
    const diff = reloadable.reload(gen(upstream.baseUrl, [tool("thing", "/new")]));
    assert.equal(diff.changed[0].name, "thing");
    assert.ok(diff.changed[0].changes.includes("endpoint"));

    const res = await client.callTool({ name: "thing", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    assert.match(text, /"path":"\/new"/);
  } finally {
    await client.close();
    await upstream.close();
  }
});
