import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { executeTool } from "../src/runtime/proxy.js";
import type { ParamStyle, ToolDef, ToolParam } from "../src/types.js";

/** Spin up a throwaway HTTP server that records the request line it received. */
async function captureServer(): Promise<{
  baseUrl: string;
  last: () => { url: string; method: string };
  close: () => Promise<void>;
}> {
  let last = { url: "", method: "" };
  const server: Server = createServer((req, res) => {
    last = { url: req.url ?? "", method: req.method ?? "" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    last: () => last,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function queryParam(
  name: string,
  style: ParamStyle,
  explode: boolean,
  schema: ToolParam["schema"] = { type: "array" },
): ToolDef {
  return {
    name: "t",
    description: "",
    method: "GET",
    pathTemplate: "/x",
    params: [
      { name, sourceName: name, location: "query", required: false, schema, style, explode },
    ],
    body: undefined,
    security: [],
  };
}

function pathTool(pathTemplate: string, names: string[]): ToolDef {
  return {
    name: "t",
    description: "",
    method: "GET",
    pathTemplate,
    params: names.map((name) => ({
      name,
      sourceName: name,
      location: "path" as const,
      required: true,
      schema: { type: "string" },
      style: "simple" as const,
      explode: false,
    })),
    body: undefined,
    security: [],
  };
}

const ctx = (baseUrl: string) => ({ baseUrl, schemes: {}, creds: {} });

test("path parameters can't climb out of the endpoint with . or ..", async () => {
  const srv = await captureServer();
  try {
    const photos = pathTool("/api/pets/{petId}/photos", ["petId"]);
    // Unchecked, ".." would resolve to GET /api/photos — a different endpoint.
    for (const petId of ["..", "."]) {
      await assert.rejects(
        () => executeTool(photos, { petId }, ctx(srv.baseUrl)),
        /path parameters can't be "\." or "\.\."/,
      );
    }
    // Two placeholders sharing one segment can't assemble ".." either.
    await assert.rejects(
      () => executeTool(pathTool("/x/{a}{b}", ["a", "b"]), { a: ".", b: "." }, ctx(srv.baseUrl)),
      /path parameters can't be/,
    );
    assert.equal(srv.last().url, "", "no request may reach the upstream");
  } finally {
    await srv.close();
  }
});

test("path parameters that only contain dots or slashes stay in their segment", async () => {
  const srv = await captureServer();
  try {
    const photos = pathTool("/api/pets/{petId}/photos", ["petId"]);
    const cases: Array<[string, string]> = [
      ["...", "/api/pets/.../photos"],
      ["v1.2", "/api/pets/v1.2/photos"],
      ["../admin", "/api/pets/..%2Fadmin/photos"],
      ["%2e%2e", "/api/pets/%252e%252e/photos"],
    ];
    for (const [petId, expected] of cases) {
      await executeTool(photos, { petId }, ctx(srv.baseUrl));
      assert.equal(srv.last().url, expected);
    }
  } finally {
    await srv.close();
  }
});

test("form + explode arrays repeat the key", async () => {
  const srv = await captureServer();
  try {
    await executeTool(queryParam("ids", "form", true), { ids: [1, 2, 3] }, ctx(srv.baseUrl));
    assert.equal(srv.last().url, "/x?ids=1&ids=2&ids=3");
  } finally {
    await srv.close();
  }
});

test("form without explode joins with commas", async () => {
  const srv = await captureServer();
  try {
    await executeTool(queryParam("ids", "form", false), { ids: [1, 2, 3] }, ctx(srv.baseUrl));
    assert.equal(decodeURIComponent(srv.last().url), "/x?ids=1,2,3");
  } finally {
    await srv.close();
  }
});

test("spaceDelimited and pipeDelimited arrays use their separators", async () => {
  const srv = await captureServer();
  try {
    // URLSearchParams form-encodes a space as `+` (valid in query strings).
    await executeTool(queryParam("a", "spaceDelimited", false), { a: [1, 2] }, ctx(srv.baseUrl));
    assert.equal(srv.last().url, "/x?a=1+2");

    await executeTool(queryParam("b", "pipeDelimited", false), { b: [3, 4] }, ctx(srv.baseUrl));
    assert.equal(decodeURIComponent(srv.last().url), "/x?b=3|4");
  } finally {
    await srv.close();
  }
});

test("deepObject explodes object properties into bracketed keys", async () => {
  const srv = await captureServer();
  try {
    await executeTool(
      queryParam("filter", "deepObject", true, { type: "object" }),
      { filter: { role: "admin", active: true } },
      ctx(srv.baseUrl),
    );
    assert.equal(
      decodeURIComponent(srv.last().url),
      "/x?filter[role]=admin&filter[active]=true",
    );
  } finally {
    await srv.close();
  }
});
