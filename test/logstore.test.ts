import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteLogStore } from "../src/runtime/logstore.js";
import type { RequestLog } from "../src/runtime/proxy.js";

function entry(over: Partial<RequestLog> = {}): RequestLog {
  return {
    tool: "get_post",
    method: "GET",
    url: "https://api.test/posts/1",
    statusCode: 200,
    latencyMs: 12,
    requestBody: '{"id":1}',
    responseBody: '{"id":1,"title":"x"}',
    ...over,
  };
}

test("records and queries logs newest-first", async () => {
  const store = SqliteLogStore.open(":memory:");
  await store.record("api", entry({ tool: "a" }));
  await store.record("api", entry({ tool: "b" }));
  await store.record("api", entry({ tool: "c" }));

  const rows = await store.query();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.tool), ["c", "b", "a"]);
  assert.equal(rows[0].response_body, '{"id":1,"title":"x"}');
  await store.close();
});

test("filters by server, tool, and status", async () => {
  const store = SqliteLogStore.open(":memory:");
  await store.record("alpha", entry({ tool: "x", statusCode: 200 }));
  await store.record("beta", entry({ tool: "x", statusCode: 401 }));
  await store.record("beta", entry({ tool: "y", statusCode: 200 }));

  assert.equal((await store.query({ server: "beta" })).length, 2);
  assert.equal((await store.query({ tool: "x" })).length, 2);
  assert.equal((await store.query({ status: 401 })).length, 1);
  assert.equal((await store.query({ server: "beta", tool: "y" }))[0].tool, "y");
  await store.close();
});

test("afterId returns ascending rows for tailing", async () => {
  const store = SqliteLogStore.open(":memory:");
  await store.record("api", entry({ tool: "a" }));
  const first = (await store.query({ limit: 1 }))[0].id;
  await store.record("api", entry({ tool: "b" }));
  await store.record("api", entry({ tool: "c" }));

  const tail = await store.query({ afterId: first });
  assert.deepEqual(tail.map((r) => r.tool), ["b", "c"]);
  await store.close();
});

test("stores error rows with null status", async () => {
  const store = SqliteLogStore.open(":memory:");
  await store.record("api", { tool: "z", method: "POST", url: "u", latencyMs: 5, error: "boom" });
  const row = (await store.query())[0];
  assert.equal(row.status_code, null);
  assert.equal(row.error, "boom");
  await store.close();
});
