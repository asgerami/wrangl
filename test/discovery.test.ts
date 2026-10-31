import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { createReloadableServer } from "../src/runtime/server.js";
import { inputSchemaOf, searchEndpoints, words } from "../src/runtime/discovery.js";
import type { GeneratedServer, ToolDef } from "../src/types.js";

// Deterministic confirmation key (see confirmation.test.ts).
process.env.WRANGL_SECRET_KEY = "test-secret-key-at-least-32-bytes-long-xx";

const idParam = {
  name: "id", sourceName: "id", location: "path" as const, required: true,
  style: "simple" as const, explode: false, schema: { type: "string" },
};

function endpoint(name: string, method: string, path: string, description: string, over: Partial<ToolDef> = {}): ToolDef {
  const destructive = ["DELETE", "PUT", "PATCH"].includes(method);
  return {
    name, method, pathTemplate: path, description: `${description}\n\n(HTTP ${method} ${path})`,
    params: path.includes("{id}") ? [idParam] : [], security: [],
    annotations: {
      readOnlyHint: method === "GET", destructiveHint: destructive,
      idempotentHint: method !== "POST", openWorldHint: true,
    },
    ...over,
  };
}

// Named as buildTools names them: the sanitized operationId, with the original
// (camelCase) kept alongside.
const ENDPOINTS: ToolDef[] = [
  endpoint("listposts", "GET", "/posts", "List all posts.", { operationId: "listPosts" }),
  endpoint("createpost", "POST", "/posts", "Create a post.", {
    operationId: "createPost",
    body: { required: true, contentType: "application/json", schema: { type: "object", properties: { title: { type: "string" } } } },
  }),
  endpoint("getpost", "GET", "/posts/{id}", "Get one post.", { operationId: "getPost" }),
  endpoint("updatepost", "PUT", "/posts/{id}", "Replace a post.", { operationId: "updatePost" }),
  endpoint("deletepost", "DELETE", "/posts/{id}", "Delete a post.", { operationId: "deletePost" }),
  endpoint("getuser", "GET", "/users/{id}", "Get a user by id.", { operationId: "getUser", tags: ["Accounts"] }),
];

async function upstream(): Promise<{ baseUrl: string; seen: string[]; close: () => void }> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

const gen = (baseUrl: string, tools = ENDPOINTS): GeneratedServer => ({
  name: "Blog", version: "1", baseUrl, securitySchemes: {}, tools,
});

const text = (res: { content?: unknown }) => (res.content as Array<{ text: string }>)[0].text;

test("words() normalizes casing, separators, and plurals", () => {
  assert.deepEqual(words("listIssues"), ["list", "issue"]);
  assert.deepEqual(words("/repos/{owner}/issues"), ["repo", "owner", "issue"]);
  assert.deepEqual(words("Categories address"), ["category", "address"]);
});

test("an exact action word beats a same-method synonym", () => {
  // "get" and "list" are both GET, but "get post" means getpost.
  assert.equal(searchEndpoints(ENDPOINTS, "get post")[0].tool.name, "getpost");
  assert.equal(searchEndpoints(ENDPOINTS, "list posts")[0].tool.name, "listposts");
});

test("search ranks by name, path, and action verb", () => {
  const top = (q: string) => searchEndpoints(ENDPOINTS, q)[0]?.tool.name;
  assert.equal(top("create post"), "createpost");
  assert.equal(top("delete a post"), "deletepost", "'delete' favours the DELETE endpoint");
  assert.equal(top("update posts"), "updatepost");
  assert.equal(top("users"), "getuser");
  assert.equal(top("accounts"), "getuser", "tags are searched");
  assert.deepEqual(searchEndpoints(ENDPOINTS, "invoices"), []);
  assert.deepEqual(searchEndpoints(ENDPOINTS, "the"), [], "stopwords alone match nothing");
  assert.equal(searchEndpoints(ENDPOINTS, "post", 2).length, 2, "limit is respected");
});

test("an endpoint's input schema lists its params and body", () => {
  const schema = inputSchemaOf(ENDPOINTS[1]);
  assert.deepEqual(schema.required, ["body"]);
  assert.equal((schema.properties?.body as { type: string }).type, "object");
  assert.deepEqual(inputSchemaOf(ENDPOINTS[2]).required, ["id"]);
});

test("discovery mode exposes three tools that find, describe, and call endpoints", async () => {
  const api = await upstream();
  const reloadable = createReloadableServer(gen(api.baseUrl), { creds: {}, toolMode: "discovery" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await reloadable.server.connect(serverT);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(clientT);

  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["call_endpoint", "describe_endpoint", "search_endpoints"]);
    assert.match(client.getInstructions() ?? "", /6 endpoints through three tools/);

    const found = text(await client.callTool({ name: "search_endpoints", arguments: { query: "create post" } }));
    assert.match(found, /^\d+ of 6 endpoints match "create post"/);
    assert.match(found, /createpost: POST \/posts\n {2}Create a post\./);

    const described = JSON.parse(text(await client.callTool({ name: "describe_endpoint", arguments: { name: "getpost" } })));
    assert.equal(described.path, "/posts/{id}");
    assert.deepEqual(described.inputSchema.required, ["id"]);

    const typo = await client.callTool({ name: "describe_endpoint", arguments: { name: "get_post" } });
    assert.equal(typo.isError, true);
    assert.match(text(typo), /Unknown endpoint "get_post"\. Did you mean: getpost/);

    // Arguments are checked against the endpoint's own schema before any request.
    const bad = await client.callTool({ name: "call_endpoint", arguments: { name: "getpost", arguments: {} } });
    assert.equal(bad.isError, true);
    assert.match(text(bad), /Invalid arguments for getpost/);
    assert.deepEqual(api.seen, []);

    const ok = await client.callTool({ name: "call_endpoint", arguments: { name: "getpost", arguments: { id: "7" } } });
    assert.notEqual(ok.isError, true);
    assert.match(text(ok), /^HTTP 200/);
    assert.deepEqual(api.seen, ["GET /posts/7"]);

    // A reload swaps the endpoints behind the same three tools.
    reloadable.reload(gen(api.baseUrl, [...ENDPOINTS, endpoint("listcomments", "GET", "/comments", "List comments.")]));
    assert.equal((await client.listTools()).tools.length, 3);
    const comments = text(await client.callTool({ name: "search_endpoints", arguments: { query: "comments" } }));
    assert.match(comments, /listcomments: GET \/comments/);
  } finally {
    await client.close();
    api.close();
  }
});

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
};

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
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { ...params, _meta: META } }),
    }),
  );
  return res.json() as Promise<any>;
}

test("call_endpoint keeps the destructive-action confirmation, bound to the endpoint called", async () => {
  const api = await upstream();
  const { server } = createReloadableServer(gen(api.baseUrl), { creds: {}, toolMode: "discovery" });
  const handler = createMcpHandler(() => server, { legacy: "stateless" });
  const accept = { confirm: { action: "accept", content: { confirm: true } } };

  try {
    const remove = { name: "call_endpoint", arguments: { name: "deletepost", arguments: { id: "42" } } };
    const first = await call(handler, remove);
    assert.equal(first.result.resultType, "input_required");
    assert.deepEqual(api.seen, [], "nothing runs before confirmation");

    // The confirmation for deletepost can't be replayed onto another endpoint
    // with the same arguments, even though both go through call_endpoint.
    const replay = await call(handler, {
      name: "call_endpoint",
      arguments: { name: "updatepost", arguments: { id: "42" } },
      inputResponses: accept,
      requestState: first.result.requestState,
    }, 2);
    assert.equal(replay.result.resultType, "input_required");
    assert.deepEqual(api.seen, []);

    const confirmed = await call(handler, { ...remove, inputResponses: accept, requestState: first.result.requestState }, 3);
    assert.equal(confirmed.result.resultType, "complete");
    assert.equal(confirmed.result.isError, false);
    assert.deepEqual(api.seen, ["DELETE /posts/42"], "runs exactly once, once confirmed");

    // Reads never ask.
    const read = await call(handler, { name: "call_endpoint", arguments: { name: "getpost", arguments: { id: "1" } } }, 4);
    assert.equal(read.result.resultType, "complete");
  } finally {
    api.close();
    await handler.close();
  }
});

test("`generate --discovery` serves the three tools over stdio, as an agent client launches it", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(root, "src", "cli.ts"), "generate", "--catalog", "jsonplaceholder", "--discovery"],
    stderr: "ignore",
  });
  const client = new Client({ name: "t", version: "1" });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["call_endpoint", "describe_endpoint", "search_endpoints"]);
    const found = text(await client.callTool({ name: "search_endpoints", arguments: { query: "get post" } }));
    assert.match(found, /getpost: GET \/posts\/\{id\}/);
  } finally {
    await client.close();
  }
});

test("WRANGL_TOOL_MODE=discovery turns on discovery mode for a launcher that only sets env", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(root, "src", "cli.ts"), "generate", "--catalog", "jsonplaceholder"],
    env: { ...(process.env as Record<string, string>), WRANGL_TOOL_MODE: "discovery" },
    stderr: "ignore",
  });
  const client = new Client({ name: "t", version: "1" });
  await client.connect(transport);
  try {
    assert.equal((await client.listTools()).tools.length, 3);
  } finally {
    await client.close();
  }
});
