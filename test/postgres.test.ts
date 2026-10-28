import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { openServerStore, isPostgresUrl } from "../src/controlplane/store.js";
import { openLogStore } from "../src/runtime/logstore.js";
import { ServerRegistry } from "../src/controlplane/registry.js";
import { Vault } from "../src/controlplane/vault.js";
import pg from "pg";

/**
 * Postgres backend integration tests. Skipped unless WRANGL_PG_URL points at a
 * reachable database (e.g. a local `postgres:16` container). Verifies the
 * Postgres stores implement the same contract as SQLite and that two registries
 * sharing one database behave like two replicas (read-through resolve).
 */

const PG = process.env.WRANGL_PG_URL;
const skip = !PG;
const here = dirname(fileURLToPath(import.meta.url));
const SPEC = join(here, "..", "examples", "jsonplaceholder.yaml");

// Give each test its own id namespace so reruns against a persistent DB are clean.
const ns = () => "t" + randomBytes(4).toString("hex");

test("isPostgresUrl detects connection strings", () => {
  assert.equal(isPostgresUrl("postgres://u:p@h/db"), true);
  assert.equal(isPostgresUrl("postgresql://h/db"), true);
  assert.equal(isPostgresUrl("/data/wrangl.db"), false);
  assert.equal(isPostgresUrl(":memory:"), false);
});

test("PostgresServerStore round-trips records, credentials, and oauth", { skip }, async () => {
  const store = await openServerStore(PG!);
  const id = ns();
  try {
    await store.upsert({ id, name: "PG", slug: id, specSource: "s", baseUrl: "u", createdAt: 5, mcpToken: "tok" });
    const got = await store.get(id);
    assert.equal(got?.name, "PG");
    assert.equal(got?.mcpToken, "tok");
    assert.ok((await store.all()).some((r) => r.id === id));

    await store.setCredential(id, "bearerAuth", "v1:enc");
    assert.deepEqual(await store.credentialsFor(id), { bearerAuth: "v1:enc" });
    await store.setOAuth(id, "userAuth", "v1:oauthblob");
    assert.deepEqual(await store.oauthFor(id), { userAuth: "v1:oauthblob" });

    await store.delete(id);
    assert.equal(await store.get(id), undefined);
    assert.deepEqual(await store.credentialsFor(id), {});
  } finally {
    await store.close();
  }
});

test("PostgresLogStore records and queries", { skip }, async () => {
  const store = await openLogStore(PG!);
  const server = ns();
  try {
    await store.record(server, { tool: "a", method: "GET", url: "u", statusCode: 200, latencyMs: 3 });
    await store.record(server, { tool: "b", method: "GET", url: "u", statusCode: 401, latencyMs: 4 });
    const rows = await store.query({ server });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.tool), ["b", "a"]); // newest-first
    assert.equal((await store.query({ server, status: 401 })).length, 1);
    assert.equal(await store.prune(Date.now() - 60_000), 0, "recent rows are kept");
  } finally {
    await store.close();
  }
});

test("two registries sharing Postgres behave like replicas (read-through)", { skip }, async () => {
  const key = randomBytes(32);
  const store1 = await openServerStore(PG!);
  const store2 = await openServerStore(PG!);
  try {
    // "Replica A" creates a server with a credential.
    const regA = new ServerRegistry({ serverStore: store1, vault: new Vault(key) });
    const entry = await regA.create({ spec: SPEC, name: ns(), auth: { bearerAuth: "sk-shared" } });

    // "Replica B" has a cold cache — get() misses, resolve() reads through.
    const regB = new ServerRegistry({ serverStore: store2, vault: new Vault(key) });
    assert.equal(regB.get(entry.id), undefined);
    const resolved = await regB.resolve(entry.id);
    assert.ok(resolved, "replica B should build the server from the shared DB");
    assert.equal(resolved?.slug, entry.slug);
    assert.equal(resolved?.generated.tools.length, 4);
    assert.equal(resolved?.creds.bearerAuth, "sk-shared"); // decrypted with the shared key

    // A delete on A is visible to B on its next resolve.
    await regA.remove(entry.id);
    const regC = new ServerRegistry({ serverStore: store2, vault: new Vault(key) });
    assert.equal(await regC.resolve(entry.id), undefined);
  } finally {
    await store1.close();
    await store2.close();
  }
});

test("an older Postgres servers table gains the newer columns on connect", { skip }, async () => {
  // A schema of its own, so this test's old-style table can't disturb the others.
  const schema = `wrangl_migrate_${ns()}`;
  const admin = new pg.Pool({ connectionString: PG });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(
    `CREATE TABLE ${schema}.servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
       spec_source TEXT NOT NULL, base_url TEXT NOT NULL, created_at BIGINT NOT NULL)`,
  );
  try {
    const url = new URL(PG!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const store = await openServerStore(url.toString());
    await store.upsert({
      id: "jp", name: "JP", slug: "jp", specSource: SPEC, baseUrl: "https://x", createdAt: 1,
      mcpToken: "tok", toolFilter: { include: ["get*"] },
    });
    const record = await store.get("jp");
    assert.equal(record?.mcpToken, "tok");
    assert.deepEqual(record?.toolFilter, { include: ["get*"] });
    await store.close();
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test("Postgres keeps pending OAuth sign-ins single-use and prunes old ones", { skip }, async () => {
  const store = await openServerStore(PG!);
  const state = ns();
  try {
    await store.savePendingAuth(state, "enc", Date.now());
    assert.equal((await store.takePendingAuth(state))?.dataEnc, "enc");
    assert.equal(await store.takePendingAuth(state), undefined, "a state works once");

    const old = ns();
    await store.savePendingAuth(old, "enc", Date.now() - 3_600_000);
    await store.prunePendingAuth(Date.now() - 600_000);
    assert.equal(await store.takePendingAuth(old), undefined, "expired sign-ins are pruned");
  } finally {
    await store.close();
  }
});
