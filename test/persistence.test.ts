import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SqliteServerStore } from "../src/controlplane/store.js";
import { ServerRegistry } from "../src/controlplane/registry.js";
import { Vault } from "../src/controlplane/vault.js";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = join(here, "..", "examples", "jsonplaceholder.yaml");

test("ServerStore upserts, lists, and deletes records", async () => {
  const store = SqliteServerStore.open(":memory:");
  await store.upsert({ id: "a", name: "A", slug: "a", specSource: "s1", baseUrl: "u1", createdAt: 1 });
  await store.upsert({ id: "b", name: "B", slug: "b", specSource: "s2", baseUrl: "u2", createdAt: 2 });

  let all = await store.all();
  assert.deepEqual(all.map((r) => r.id), ["a", "b"]); // oldest first

  // Upsert on the same id updates in place rather than duplicating.
  await store.upsert({ id: "a", name: "A2", slug: "a", specSource: "s1b", baseUrl: "u1", createdAt: 1 });
  all = await store.all();
  assert.equal(all.length, 2);
  assert.equal(all.find((r) => r.id === "a")?.name, "A2");

  await store.delete("a");
  assert.deepEqual((await store.all()).map((r) => r.id), ["b"]);
  await store.close();
});

test("a server created with a store survives a fresh registry (rehydrate)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wrangl-persist-"));
  const dbPath = join(dir, "cp.db");

  // First registry: create a server, then close the store.
  const store1 = SqliteServerStore.open(dbPath);
  const reg1 = new ServerRegistry({ serverStore: store1 });
  const created = await reg1.create({ spec: SPEC, name: "Persisted API" });
  assert.equal(created.slug, "persisted-api");
  await store1.close();

  // Second registry on the same file: load() re-ingests the stored spec.
  const store2 = SqliteServerStore.open(dbPath);
  const reg2 = new ServerRegistry({ serverStore: store2 });
  const result = await reg2.load();
  assert.equal(result.restored, 1);
  assert.equal(result.failed.length, 0);

  const list = reg2.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].slug, "persisted-api");
  assert.equal(list[0].toolCount, 4);
  // createdAt is preserved across the restart.
  assert.equal(list[0].createdAt, created.createdAt);
  await store2.close();
});

test("a server's tool filter survives a restart", async () => {
  const dbPath = join(await mkdtemp(join(tmpdir(), "wrangl-persist-")), "cp.db");
  const store1 = SqliteServerStore.open(dbPath);
  await new ServerRegistry({ serverStore: store1 }).create({ spec: SPEC, name: "JP", include: ["get*"] });
  await store1.close();

  const store2 = SqliteServerStore.open(dbPath);
  const reg2 = new ServerRegistry({ serverStore: store2 });
  await reg2.load();
  assert.deepEqual(reg2.tools("jp")?.map((t) => t.name).sort(), ["getpost", "getuser"]);
  await store2.close();
});

test("two replicas sharing a store never hand out the same slug", async () => {
  const dbPath = join(await mkdtemp(join(tmpdir(), "wrangl-persist-")), "cp.db");
  // Both replicas boot first, so neither has the other's servers in memory.
  const storeA = SqliteServerStore.open(dbPath);
  const storeB = SqliteServerStore.open(dbPath);
  const replicaA = new ServerRegistry({ serverStore: storeA });
  const replicaB = new ServerRegistry({ serverStore: storeB });

  const first = await replicaA.create({ spec: SPEC, name: "Shared API" });
  const second = await replicaB.create({ spec: SPEC, name: "Shared API" });
  assert.equal(first.slug, "shared-api");
  assert.equal(second.slug, "shared-api-2", "B must not reuse (and overwrite) A's slug");
  assert.equal((await storeA.get("shared-api"))?.mcpToken, first.mcpToken, "A's record is intact");
  await storeA.close();
  await storeB.close();
});

test("a replica sees credentials, regenerates, creates, and deletes made by another", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wrangl-persist-"));
  const dbPath = join(dir, "cp.db");
  const specPath = join(dir, "spec.json");
  const spec = (paths: string[]) =>
    JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Shared", version: "1" },
      servers: [{ url: "https://api.example.test" }],
      paths: Object.fromEntries(paths.map((p) => [p, { get: { responses: {} } }])),
    });
  await writeFile(specPath, spec(["/a", "/b"]));

  const vault = new Vault(randomBytes(32));
  const storeA = SqliteServerStore.open(dbPath);
  const storeB = SqliteServerStore.open(dbPath);
  // staleAfterMs: 0 re-checks the store on every lookup, so no waiting.
  const replicaA = new ServerRegistry({ serverStore: storeA, vault, staleAfterMs: 0 });
  const replicaB = new ServerRegistry({ serverStore: storeB, vault, staleAfterMs: 0 });

  const { id } = await replicaA.create({ spec: specPath, name: "Shared" });
  assert.equal((await replicaB.resolve(id))?.generated.tools.length, 2, "read-through on first use");

  await replicaA.setCredential(id, "apiKey", "k-new");
  assert.equal((await replicaB.resolve(id))?.creds.apiKey, "k-new", "credential set elsewhere");

  await writeFile(specPath, spec(["/a"]));
  await replicaA.regenerate(id);
  assert.equal((await replicaB.resolve(id))?.generated.tools.length, 1, "regenerated elsewhere");

  const other = await replicaA.create({ spec: specPath, name: "Other" });
  await replicaB.sync();
  assert.ok(replicaB.list().some((s) => s.id === other.id), "created elsewhere shows in the list");

  await replicaA.remove(id);
  assert.equal(await replicaB.resolve(id), undefined, "deleted elsewhere stops being served");
  await replicaB.sync();
  assert.deepEqual(replicaB.list().map((s) => s.id), [other.id]);

  await storeA.close();
  await storeB.close();
});

test("a database from before tool filters is migrated on open", async () => {
  const dbPath = join(await mkdtemp(join(tmpdir(), "wrangl-persist-")), "old.db");
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
    spec_source TEXT NOT NULL, base_url TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  old.prepare("INSERT INTO servers VALUES (?, ?, ?, ?, ?, ?)").run("jp", "JP", "jp", SPEC, "https://x", 1);
  old.close();

  const store = SqliteServerStore.open(dbPath);
  const record = await store.get("jp");
  assert.equal(record?.toolFilter, undefined);
  assert.equal(record?.mcpToken, undefined);
  await store.upsert({ ...record!, toolFilter: { include: ["get*"] } });
  assert.deepEqual((await store.get("jp"))?.toolFilter, { include: ["get*"] });
  await store.close();
});

test("credentials persist encrypted and are restored on rehydrate", async () => {
  const store1 = SqliteServerStore.open(":memory:");
  const key = randomBytes(32);
  const reg1 = new ServerRegistry({ serverStore: store1, vault: new Vault(key) });
  const entry = await reg1.create({ spec: SPEC, auth: { bearerAuth: "sk-secret" } });
  await reg1.setCredential(entry.id, "apiKeyAuth", "key-123");

  // On disk, the value is an encrypted envelope, not the plaintext.
  const stored = await store1.credentialsFor(entry.id);
  assert.match(stored.bearerAuth, /^v1:/);
  assert.ok(!JSON.stringify(stored).includes("sk-secret"));

  // A fresh registry with the same key + store decrypts them back.
  const reg2 = new ServerRegistry({ serverStore: store1, vault: new Vault(key) });
  const result = await reg2.load();
  assert.equal(result.restored, 1);
  assert.equal(reg2.get(entry.id)?.creds.bearerAuth, "sk-secret");
  assert.equal(reg2.get(entry.id)?.creds.apiKeyAuth, "key-123");
  await store1.close();
});

test("a wrong key skips the credential but still loads the server", async () => {
  const store = SqliteServerStore.open(":memory:");
  const reg1 = new ServerRegistry({ serverStore: store, vault: new Vault(randomBytes(32)) });
  const entry = await reg1.create({ spec: SPEC, auth: { bearerAuth: "sk-secret" } });

  const reg2 = new ServerRegistry({ serverStore: store, vault: new Vault(randomBytes(32)) });
  const result = await reg2.load();
  assert.equal(result.restored, 1); // server still loads
  assert.equal(reg2.get(entry.id)?.creds.bearerAuth, undefined); // bad cred skipped
  await store.close();
});

test("without a vault, credentials are not persisted", async () => {
  const store = SqliteServerStore.open(":memory:");
  const reg = new ServerRegistry({ serverStore: store }); // no vault
  const entry = await reg.create({ spec: SPEC, auth: { bearerAuth: "sk-secret" } });
  assert.deepEqual(await store.credentialsFor(entry.id), {});
  await store.close();
});

test("removing a server deletes its persisted record", async () => {
  const store = SqliteServerStore.open(":memory:");
  const reg = new ServerRegistry({ serverStore: store });
  const entry = await reg.create({ spec: SPEC });
  assert.equal((await store.all()).length, 1);

  await reg.remove(entry.id);
  assert.equal((await store.all()).length, 0);
  await store.close();
});

test("load reports specs it can't re-ingest without dropping them", async () => {
  const store = SqliteServerStore.open(":memory:");
  await store.upsert({
    id: "broken",
    name: "Broken",
    slug: "broken",
    specSource: "/nonexistent/spec.yaml",
    baseUrl: "https://x",
    createdAt: 1,
  });
  const reg = new ServerRegistry({ serverStore: store });
  const result = await reg.load();
  assert.equal(result.restored, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, "broken");
  // The record is kept for a future boot, not silently dropped.
  assert.equal((await store.all()).length, 1);
  await store.close();
});
