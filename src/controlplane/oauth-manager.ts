import type { ServerRegistry } from "./registry.js";
import type { ServerStore } from "./store.js";
import type { Vault } from "./vault.js";
import {
  buildAuthorizeUrl,
  codeChallenge,
  exchangeCode,
  generateCodeVerifier,
  generateState,
  isExpired,
  refreshTokens,
  type OAuthConfig,
  type TokenSet,
} from "./oauth.js";

/**
 * Manages the OAuth2 authorization-code flow for hosted servers: stores client
 * config + tokens encrypted (via the vault), builds authorize URLs, handles the
 * callback, refreshes expired tokens, and injects the current access token into
 * the server's live credential store so upstream calls are authenticated on the
 * end user's behalf.
 */

export interface OAuthConfigInput {
  clientId: string;
  clientSecret?: string;
  /** Defaults to the spec's authorization/token URLs and scopes when omitted. */
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
}

interface StoredConfig {
  clientId: string;
  clientSecret?: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  redirectUri: string;
}

interface OAuthState {
  config: StoredConfig;
  tokens?: TokenSet;
}

export interface OAuthStatus {
  scheme: string;
  configured: boolean;
  connected: boolean;
  expiresAt?: number;
}

interface Pending {
  serverId: string;
  scheme: string;
  codeVerifier: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000; // authorization requests expire after 10m

export class OAuthManager {
  private registry: ServerRegistry;
  private store: ServerStore;
  private vault: Vault;
  private callbackUrl: string;
  private pending = new Map<string, Pending>();

  constructor(opts: {
    registry: ServerRegistry;
    store: ServerStore;
    vault: Vault;
    /** Absolute callback URL, e.g. http://127.0.0.1:4000/oauth/callback */
    callbackUrl: string;
  }) {
    this.registry = opts.registry;
    this.store = opts.store;
    this.vault = opts.vault;
    this.callbackUrl = opts.callbackUrl;
  }

  /** Set/merge client config for a scheme, defaulting URLs/scopes from the spec. */
  async configure(serverId: string, scheme: string, input: OAuthConfigInput): Promise<void> {
    const specScheme = this.specScheme(serverId, scheme);
    const existing = await this.loadState(serverId, scheme);
    const config: StoredConfig = {
      clientId: input.clientId,
      clientSecret: input.clientSecret ?? existing?.config.clientSecret,
      authorizationUrl:
        input.authorizationUrl ?? existing?.config.authorizationUrl ?? specScheme?.authorizationUrl ?? "",
      tokenUrl: input.tokenUrl ?? existing?.config.tokenUrl ?? specScheme?.tokenUrl ?? "",
      scopes: input.scopes ?? existing?.config.scopes ?? specScheme?.scopes ?? [],
      redirectUri: this.callbackUrl,
    };
    if (!config.authorizationUrl || !config.tokenUrl) {
      throw new Error(
        "OAuth authorizationUrl and tokenUrl are required (the spec did not " +
          "provide them — pass authorizationUrl/tokenUrl in the config).",
      );
    }
    await this.saveState(serverId, scheme, { config, tokens: existing?.tokens });
  }

  /** Begin authorization: returns the URL the user must visit to grant access. */
  async startAuthorization(serverId: string, scheme: string): Promise<string> {
    const state = await this.loadState(serverId, scheme);
    if (!state?.config.clientId) {
      throw new Error(`OAuth for "${scheme}" is not configured yet.`);
    }
    const csrf = generateState();
    const verifier = generateCodeVerifier();
    this.pending.set(csrf, { serverId, scheme, codeVerifier: verifier, createdAt: Date.now() });
    this.sweepPending();
    return buildAuthorizeUrl(toConfig(state.config), {
      state: csrf,
      codeChallenge: codeChallenge(verifier),
    });
  }

  /** Handle the provider redirect: exchange the code and store the tokens. */
  async handleCallback(csrf: string, code: string): Promise<{ serverId: string; scheme: string }> {
    const pending = this.pending.get(csrf);
    if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
      this.pending.delete(csrf);
      throw new Error("Unknown or expired authorization state.");
    }
    this.pending.delete(csrf);

    const state = await this.loadState(pending.serverId, pending.scheme);
    if (!state) throw new Error("OAuth configuration disappeared mid-flow.");

    const tokens = await exchangeCode(toConfig(state.config), {
      code,
      codeVerifier: pending.codeVerifier,
    });
    state.tokens = tokens;
    await this.saveState(pending.serverId, pending.scheme, state);
    this.applyToken(pending.serverId, pending.scheme, tokens.accessToken);
    return { serverId: pending.serverId, scheme: pending.scheme };
  }

  /** Refresh the access token; returns false if no refresh token is available. */
  async refresh(serverId: string, scheme: string): Promise<boolean> {
    const state = await this.loadState(serverId, scheme);
    if (!state?.tokens?.refreshToken) return false;
    const tokens = await refreshTokens(toConfig(state.config), state.tokens.refreshToken);
    state.tokens = tokens;
    await this.saveState(serverId, scheme, state);
    this.applyToken(serverId, scheme, tokens.accessToken);
    return true;
  }

  async status(serverId: string, scheme: string): Promise<OAuthStatus> {
    const state = await this.loadState(serverId, scheme);
    return {
      scheme,
      configured: !!state?.config.clientId,
      connected: !!state?.tokens?.accessToken,
      expiresAt: state?.tokens?.expiresAt,
    };
  }

  /** Statuses for every oauth2 scheme on a server. */
  async statuses(serverId: string): Promise<OAuthStatus[]> {
    const entry = this.registry.get(serverId);
    if (!entry) return [];
    const oauthSchemes = Object.values(entry.generated.securitySchemes).filter(
      (s) => s.type === "oauth2",
    );
    return Promise.all(oauthSchemes.map((s) => this.status(serverId, s.name)));
  }

  /**
   * After the registry rehydrates servers, re-inject stored access tokens (and
   * proactively refresh expired ones) so OAuth-secured servers work post-restart.
   */
  async restoreAll(): Promise<void> {
    for (const summary of this.registry.list()) {
      await this.restoreServer(summary.id);
    }
  }

  /**
   * Inject stored access tokens for one server (refreshing expired ones) — used
   * both on boot and when a replica read-through-resolves a server another
   * replica created.
   */
  async restoreServer(serverId: string): Promise<void> {
    for (const scheme of Object.keys(await this.store.oauthFor(serverId))) {
      const state = await this.loadState(serverId, scheme);
      if (!state?.tokens?.accessToken) continue;
      if (isExpired(state.tokens) && state.tokens.refreshToken) {
        try {
          await this.refresh(serverId, scheme);
          continue;
        } catch {
          // fall through to using the (possibly expired) token
        }
      }
      this.applyToken(serverId, scheme, state.tokens.accessToken);
    }
  }

  // ---- internals ----

  private applyToken(serverId: string, scheme: string, accessToken: string): void {
    const entry = this.registry.get(serverId);
    if (entry) entry.creds[scheme] = accessToken; // live injection, by reference
  }

  private specScheme(serverId: string, scheme: string):
    | { authorizationUrl?: string; tokenUrl?: string; scopes: string[] }
    | undefined {
    const s = this.registry.get(serverId)?.generated.securitySchemes[scheme];
    return s?.type === "oauth2" ? s : undefined;
  }

  private async loadState(serverId: string, scheme: string): Promise<OAuthState | undefined> {
    const enc = (await this.store.oauthFor(serverId))[scheme];
    if (!enc) return undefined;
    try {
      return JSON.parse(this.vault.decrypt(enc)) as OAuthState;
    } catch {
      return undefined; // wrong key / tampered — treat as unconfigured
    }
  }

  private async saveState(serverId: string, scheme: string, state: OAuthState): Promise<void> {
    await this.store.setOAuth(serverId, scheme, this.vault.encrypt(JSON.stringify(state)));
  }

  private sweepPending(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [key, p] of this.pending) if (p.createdAt < cutoff) this.pending.delete(key);
  }
}

function toConfig(c: StoredConfig): OAuthConfig {
  return {
    authorizationUrl: c.authorizationUrl,
    tokenUrl: c.tokenUrl,
    clientId: c.clientId,
    clientSecret: c.clientSecret,
    redirectUri: c.redirectUri,
    scopes: c.scopes,
  };
}
