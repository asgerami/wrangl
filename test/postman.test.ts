import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ingest } from "../src/parser/openapi.js";
import { isPostmanCollection, postmanToOpenAPI } from "../src/parser/postman.js";

const here = dirname(fileURLToPath(import.meta.url));
const COLLECTION = join(here, "..", "examples", "postman-collection.json");

test("isPostmanCollection detects collections, not OpenAPI docs", () => {
  assert.equal(
    isPostmanCollection({ info: { schema: "https://schema.getpostman.com/x" }, item: [] }),
    true,
  );
  assert.equal(isPostmanCollection({ openapi: "3.0.0", paths: {} }), false);
  assert.equal(isPostmanCollection({ swagger: "2.0" }), false);
  assert.equal(isPostmanCollection(null), false);
});

test("ingest converts a Postman collection into tools", async () => {
  const gen = await ingest(COLLECTION);
  assert.equal(gen.baseUrl, "https://jsonplaceholder.typicode.com");
  assert.equal(gen.tools.length, 3);

  const names = gen.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["create_post", "get_post_by_id", "list_posts"]);
});

test("Postman path variables and query params map correctly", async () => {
  const gen = await ingest(COLLECTION);

  const getById = gen.tools.find((t) => t.name === "get_post_by_id")!;
  assert.equal(getById.method, "GET");
  assert.equal(getById.pathTemplate, "/posts/{id}");
  const id = getById.params.find((p) => p.name === "id");
  assert.equal(id?.location, "path");
  assert.equal(id?.required, true);

  const list = gen.tools.find((t) => t.name === "list_posts")!;
  const userId = list.params.find((p) => p.name === "userid");
  assert.equal(userId?.location, "query");
});

test("Postman collection auth becomes a security scheme", async () => {
  const gen = await ingest(COLLECTION);
  assert.ok(gen.securitySchemes.bearerAuth);
  for (const tool of gen.tools) {
    assert.deepEqual(tool.security, ["bearerAuth"]);
  }
});

test("raw-JSON request body infers a shallow object schema", async () => {
  const gen = await ingest(COLLECTION);
  const create = gen.tools.find((t) => t.name === "create_post")!;
  assert.ok(create.body);
  assert.equal(create.body?.contentType, "application/json");
  assert.equal(create.body?.schema.type, "object");
  assert.ok(create.body?.schema.properties?.title);
});

test("apikey auth maps to an apiKey security scheme", () => {
  const doc = postmanToOpenAPI({
    info: { name: "x", schema: "getpostman.com" },
    item: [
      {
        name: "ping",
        request: {
          method: "GET",
          url: { raw: "https://api.example.com/ping", host: ["api", "example", "com"], path: ["ping"] },
          auth: { type: "apikey", apikey: [{ key: "key", value: "X-Token" }, { key: "in", value: "header" }] },
        },
      },
    ],
  });
  assert.deepEqual(doc.components?.securitySchemes?.apiKeyAuth, {
    type: "apiKey",
    in: "header",
    name: "X-Token",
  });
});
