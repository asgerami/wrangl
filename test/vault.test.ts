import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Vault } from "../src/controlplane/vault.js";

test("encrypt/decrypt round-trips", () => {
  const vault = new Vault(randomBytes(32));
  const secret = "sk-test-12345";
  const env = vault.encrypt(secret);
  assert.notEqual(env, secret);
  assert.match(env, /^v1:/);
  assert.equal(vault.decrypt(env), secret);
});

test("each encryption uses a fresh nonce (ciphertext differs)", () => {
  const vault = new Vault(randomBytes(32));
  assert.notEqual(vault.encrypt("same"), vault.encrypt("same"));
});

test("tampered envelopes fail authentication", () => {
  const vault = new Vault(randomBytes(32));
  const env = vault.encrypt("secret");
  const tampered = env.slice(0, -2) + (env.endsWith("AA") ? "BB" : "AA");
  assert.throws(() => vault.decrypt(tampered));
});

test("a different key cannot decrypt", () => {
  const env = new Vault(randomBytes(32)).encrypt("secret");
  assert.throws(() => new Vault(randomBytes(32)).decrypt(env));
});

test("fromSecret accepts hex, base64, and passphrase", () => {
  const hex = "a".repeat(64);
  assert.ok(Vault.fromSecret(hex));
  const b64 = randomBytes(32).toString("base64");
  assert.ok(Vault.fromSecret(b64));

  // A passphrase is deterministic: same phrase decrypts what it encrypted.
  const v1 = Vault.fromSecret("correct horse battery staple")!;
  const v2 = Vault.fromSecret("correct horse battery staple")!;
  assert.equal(v2.decrypt(v1.encrypt("hi")), "hi");
});

test("fromSecret(undefined) and fromEnv without a key return undefined", () => {
  assert.equal(Vault.fromSecret(undefined), undefined);
  assert.equal(Vault.fromEnv({}), undefined);
});

test("a wrong-length raw key is rejected", () => {
  assert.throws(() => new Vault(randomBytes(16)));
});
