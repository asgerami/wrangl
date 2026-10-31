import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWTPayload } from "jose";
import { ServerRegistry } from "../src/controlplane/registry.js";
import { buildControlPlane } from "../src/controlplane/api.js";
import { AgentAuth, discoveryUrls } from "../src/controlplane/agent-auth.js";
import { SqliteLogStore } from "../src/runtime/logstore.js";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = join(here, "..", "examples", "jsonplaceholder.yaml");
const PUBLIC_URL = "https://mcp.example.test";
const RESOURCE = `${PUBLIC_URL}/servers/jp/mcp`;
const METADATA_URL = `${PUBLIC_URL}/.well-known/oauth-protected-resource/servers/jp/mcp`;

/** A stand-in identity provider: OIDC discovery under a realm path, like Keycloak, and a JWKS. */
let idp: Server;
let issuer: string;
let signingKey: CryptoKey;
let strangerKey: CryptoKey;

before(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  strangerKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  idp = createHttpServer((req, res) => {
    const json = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/realms/wrangl/.well-known/openid-configuration") {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/certs`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (req.url === "/realms/wrangl/certs") return json({ keys: [jwk] });
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/realms/wrangl`;
});

after(() => new Promise<void>((r) => idp.close(() => r())));

async function token(claims: JWTPayload = {}, key: CryptoKey = signingKey): Promise<string> {
  return new SignJWT({ scope: "mcp:tools", azp: "claude", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(claims.iss ?? issuer)
    .setAudience(claims.aud ?? RESOURCE)
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? "5m")
    .sign(key);
}

async function controlPlane(auth: { requiredScopes?: string[]; audiences?: string[] } = {}) {
  const registry = new ServerRegistry({ logStore: SqliteLogStore.open(":memory:") });
  const agentAuth = await AgentAuth.discover({ issuer, ...auth });
  // An admin token, to show the sign-in routes stay public when the management API isn't.
  const app = buildControlPlane(registry, { agentAuth, publicUrl: PUBLIC_URL, adminToken: "admin" });
  const created = await app.inject({
    method: "POST", url: "/servers", headers: { authorization: "Bearer admin" },
    payload: { spec: SPEC, name: "JP" },
  });
  return { app, mcpToken: created.json().mcpToken as string };
}

const listTools = (authorization?: string) => ({
  method: "POST" as const,
  url: "/servers/jp/mcp",
  headers: {
    ...(authorization ? { authorization } : {}),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": "tools/list",
  },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } },
  }),
});

test("discovery URLs follow the spec's order, with and without an issuer path", () => {
  assert.deepEqual(discoveryUrls("https://idp.test"), [
    "https://idp.test/.well-known/oauth-authorization-server",
    "https://idp.test/.well-known/openid-configuration",
  ]);
  assert.deepEqual(discoveryUrls("https://idp.test/realms/x/"), [
    "https://idp.test/.well-known/oauth-authorization-server/realms/x",
    "https://idp.test/.well-known/openid-configuration/realms/x",
    "https://idp.test/realms/x/.well-known/openid-configuration",
  ]);
});

test("an issuer with no metadata, or metadata naming another issuer, fails at startup", async () => {
  await assert.rejects(AgentAuth.discover({ issuer: `${issuer}-missing` }), /No OAuth or OpenID Connect metadata/);
  // The document found must name the issuer it was looked up for.
  const impostor = async () =>
    new Response(JSON.stringify({ issuer: "https://evil.test", jwks_uri: "https://evil.test/keys" }));
  await assert.rejects(AgentAuth.discover({ issuer, fetch: impostor }), /No OAuth or OpenID Connect metadata/);
});

test("each hosted server publishes its protected resource metadata", async () => {
  const { app } = await controlPlane({ requiredScopes: ["mcp:tools"] });
  const res = await app.inject({ url: "/.well-known/oauth-protected-resource/servers/jp/mcp" });
  assert.equal(res.statusCode, 200);
  const metadata = res.json();
  assert.equal(metadata.resource, RESOURCE, "the resource is exactly the MCP URL");
  assert.deepEqual(metadata.authorization_servers, [issuer]);
  assert.deepEqual(metadata.scopes_supported, ["mcp:tools"]);
  assert.equal(metadata.resource_name, "JSONPlaceholder");
  assert.equal(
    (await app.inject({ url: "/.well-known/oauth-protected-resource/servers/nope/mcp" })).statusCode,
    404,
  );
  await app.close();
});

test("without agent sign-in there is no metadata and the old 401 stays", async () => {
  const registry = new ServerRegistry({ logStore: SqliteLogStore.open(":memory:") });
  const app = buildControlPlane(registry);
  await app.inject({ method: "POST", url: "/servers", payload: { spec: SPEC, name: "JP" } });
  assert.equal((await app.inject({ url: "/.well-known/oauth-protected-resource/servers/jp/mcp" })).statusCode, 404);
  const res = await app.inject(listTools());
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers["www-authenticate"], undefined);
  await app.close();
});

test("a request without a token gets a challenge pointing at the metadata", async () => {
  const { app } = await controlPlane();
  const res = await app.inject(listTools());
  assert.equal(res.statusCode, 401);
  const challenge = String(res.headers["www-authenticate"]);
  assert.match(challenge, /^Bearer /);
  assert.ok(challenge.includes(`resource_metadata="${METADATA_URL}"`), challenge);
  await app.close();
});

test("a token the identity provider issued for this server is accepted", async () => {
  const { app } = await controlPlane({ requiredScopes: ["mcp:tools"] });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const { url, ...init } = listTools(`Bearer ${await token()}`);
  const res = await fetch(`http://127.0.0.1:${port}${url}`, init);
  assert.equal(res.status, 200);
  const tools = ((await res.json()) as { result: { tools: unknown[] } }).result.tools;
  assert.equal(tools.length, 4);
  await app.close();
});

test("tokens for another server, issuer, or key, expired ones, and garbage are refused", async () => {
  const { app } = await controlPlane();
  const refused = {
    "another server": await token({ aud: `${PUBLIC_URL}/servers/other/mcp` }),
    "another issuer": await token({ iss: "https://evil.test" }),
    "another key": await token({}, strangerKey),
    expired: await token({ exp: Math.floor(Date.now() / 1000) - 3600 }),
    garbage: "not-a-jwt",
  };
  for (const [why, bad] of Object.entries(refused)) {
    const res = await app.inject(listTools(`Bearer ${bad}`));
    assert.equal(res.statusCode, 401, why);
    assert.match(String(res.headers["www-authenticate"]), /error="invalid_token"/, why);
  }
  await app.close();
});

test("a token without the required scope gets a 403 step-up challenge", async () => {
  const { app } = await controlPlane({ requiredScopes: ["mcp:tools"] });
  const res = await app.inject(listTools(`Bearer ${await token({ scope: "openid" })}`));
  assert.equal(res.statusCode, 403);
  const challenge = String(res.headers["www-authenticate"]);
  assert.match(challenge, /error="insufficient_scope"/);
  assert.match(challenge, /scope="mcp:tools"/);
  // Okta and Entra ID put scopes in `scp`.
  assert.equal((await app.inject(listTools(`Bearer ${await token({ scope: undefined, scp: ["mcp:tools"] })}`))).statusCode, 200);
  await app.close();
});

test("a configured shared audience is accepted on every server", async () => {
  const { app } = await controlPlane({ audiences: ["api://wrangl"] });
  const res = await app.inject(listTools(`Bearer ${await token({ aud: "api://wrangl" })}`));
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("the server's static MCP token keeps working alongside sign-in", async () => {
  const { app, mcpToken } = await controlPlane();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const { url, ...init } = listTools(`Bearer ${mcpToken}`);
  assert.equal((await fetch(`http://127.0.0.1:${port}${url}`, init)).status, 200);
  await app.close();
});
