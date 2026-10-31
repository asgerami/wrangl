import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import {
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  verifyBearerToken,
  type AuthInfo,
  type OAuthMetadata,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/server";

/**
 * Agent sign-in through your identity provider, so a hosted server can be
 * added to Claude or ChatGPT as a custom connector (MCP authorization spec,
 * 2026-07-28). Wrangl is the OAuth *protected resource* here, not the
 * authorization server: the identity provider (Okta, Entra ID, Auth0,
 * Keycloak, ...) signs people in, registers the connector's client, and issues
 * JWT access tokens. Wrangl publishes each server's Protected Resource
 * Metadata, answers unauthenticated calls with a 401 challenge pointing at it,
 * and accepts only tokens the provider issued for that specific server.
 *
 * Not to be confused with OAuthManager, which is Wrangl signing in *to the
 * upstream APIs* it calls. The two never mix: an agent's token is checked and
 * dropped here, and upstream calls use Wrangl's own stored credentials (the
 * spec forbids passing the token through).
 */

export interface AgentAuthOptions {
  /** The identity provider's issuer URL, exactly as its metadata states it. */
  issuer: string;
  /** Scopes every token must carry; a token without them gets a 403 step-up challenge. */
  requiredScopes?: string[];
  /**
   * Audiences accepted besides each server's own MCP URL, for providers that
   * can't issue a per-server audience. A token for one of these works on
   * every hosted server.
   */
  audiences?: string[];
  /** For tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

const DISCOVERY_TIMEOUT_MS = 10_000;

export class AgentAuth {
  private constructor(
    private readonly metadata: OAuthMetadata,
    private readonly jwks: ReturnType<typeof createRemoteJWKSet>,
    private readonly options: AgentAuthOptions,
  ) {}

  /** The issuer the provider's metadata declares, used to check each token's `iss`. */
  get issuer(): string {
    return this.metadata.issuer;
  }

  /**
   * Find the provider's metadata and signing keys from its issuer URL, trying
   * the spec's discovery locations in order (RFC 8414, then OpenID Connect).
   * Runs once at startup, so a misconfigured issuer fails fast.
   */
  static async discover(options: AgentAuthOptions): Promise<AgentAuth> {
    const get = options.fetch ?? fetch;
    const tried: string[] = [];
    for (const url of discoveryUrls(options.issuer)) {
      tried.push(url);
      let metadata: Record<string, unknown>;
      try {
        const res = await get(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });
        if (!res.ok) continue;
        metadata = (await res.json()) as Record<string, unknown>;
      } catch {
        continue;
      }
      // The spec requires the issuer in the document to be exactly the one
      // used to find it; a lookalike document is not to be trusted.
      if (stripSlash(String(metadata.issuer ?? "")) !== stripSlash(options.issuer)) continue;
      if (typeof metadata.jwks_uri !== "string") {
        throw new Error(
          `The identity provider at ${options.issuer} publishes no jwks_uri. ` +
            `Wrangl validates JWT access tokens, so it needs the provider's signing keys.`,
        );
      }
      return new AgentAuth(
        metadata as unknown as OAuthMetadata,
        createRemoteJWKSet(new URL(metadata.jwks_uri)),
        options,
      );
    }
    throw new Error(
      `No OAuth or OpenID Connect metadata found for issuer ${options.issuer} (tried ${tried.join(", ")}).`,
    );
  }

  /** The RFC 9728 document for one hosted server, served at {@link metadataUrlFor}. */
  metadataFor(resource: URL, name: string): OAuthProtectedResourceMetadata {
    return buildOAuthProtectedResourceMetadata({
      oauthMetadata: this.metadata,
      resourceServerUrl: resource,
      scopesSupported: this.options.requiredScopes?.length ? this.options.requiredScopes : undefined,
      resourceName: name,
      dangerouslyAllowInsecureIssuerUrl: isLoopback(this.metadata.issuer),
    });
  }

  /** Where a server's metadata lives: the well-known path in front of its MCP path. */
  metadataUrlFor(resource: URL): string {
    return getOAuthProtectedResourceMetadataUrl(resource);
  }

  /**
   * Accept a request's bearer token for one server, or throw the OAuthError
   * to answer with (see {@link challenge}). Signature, issuer, expiry, and
   * audience are all checked; the audience must be this server's MCP URL or
   * one of the configured shared audiences.
   */
  async authenticate(authorization: string | undefined, resource: URL): Promise<AuthInfo> {
    return verifyBearerToken(authorization, {
      verifier: { verifyAccessToken: (token) => this.verify(token, resource) },
      requiredScopes: this.options.requiredScopes,
      resourceMetadataUrl: this.metadataUrlFor(resource),
      expectedResource: resource,
    });
  }

  /** The 401/403 response for a failed {@link authenticate}, with its WWW-Authenticate challenge. */
  challenge(error: unknown, resource: URL): Response {
    return bearerAuthChallengeResponse(error, {
      requiredScopes: this.options.requiredScopes,
      resourceMetadataUrl: this.metadataUrlFor(resource),
    });
  }

  private async verify(token: string, resource: URL): Promise<AuthInfo> {
    const own = stripSlash(resource.href);
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.metadata.issuer,
        audience: [own, `${own}/`, ...(this.options.audiences ?? [])],
        requiredClaims: ["exp"],
        clockTolerance: 30,
      }));
    } catch (err) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, describeJoseError(err));
    }
    return {
      token,
      clientId: String(payload.client_id ?? payload.azp ?? payload.sub ?? ""),
      scopes: scopesOf(payload),
      expiresAt: payload.exp,
      // jose already matched the audience; this tells the SDK which resource it was for.
      resource,
      extra: { sub: payload.sub },
    };
  }
}

/** Discovery URLs for an issuer, in the order the spec has clients try them. */
export function discoveryUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = stripSlash(url.pathname);
  if (!path) {
    return [
      `${url.origin}/.well-known/oauth-authorization-server`,
      `${url.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

/** Scopes from `scope` (space-separated, RFC 9068) or `scp` (Okta and Entra ID). */
function scopesOf(payload: JWTPayload): string[] {
  const raw = payload.scope ?? payload.scp;
  if (Array.isArray(raw)) return raw.map(String);
  return typeof raw === "string" ? raw.split(" ").filter(Boolean) : [];
}

function describeJoseError(err: unknown): string {
  const code = (err as { code?: string })?.code;
  switch (code) {
    case "ERR_JWT_EXPIRED":
      return "The access token has expired.";
    case "ERR_JWT_CLAIM_VALIDATION_FAILED":
      return `The access token was not issued for this server (${(err as Error).message}).`;
    case "ERR_JWS_SIGNATURE_VERIFICATION_FAILED":
    case "ERR_JWKS_NO_MATCHING_KEY":
      return "The access token's signature doesn't match the identity provider's keys.";
    default:
      return "The access token is not a valid JWT from the configured identity provider.";
  }
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
