import { createHash, randomBytes, scryptSync } from "node:crypto";
import {
  createRequestStateCodec,
  type RequestStateCodec,
} from "@modelcontextprotocol/server";

/**
 * Destructive-action confirmation (MCP 2026-07-28 multi round-trip requests).
 * A destructive tool call is gated behind a form-mode elicitation; the
 * `requestState` that ties a confirmation to the exact call it was issued for
 * is HMAC-signed via the SDK's `createRequestStateCodec` — never hand-rolled,
 * per the spec's integrity MUST (basic/patterns/mrtr, server requirements 4-5).
 */

/** How long a confirmation prompt stays valid before the client must re-elicit. */
const CONFIRM_TTL_SECONDS = 5 * 60;

export interface ConfirmationState {
  tool: string;
  /** Digest of the call's arguments, so a confirmation can't be replayed onto a different call. */
  argsDigest: string;
}

let warnedNoSecret = false;
let cached: { codec: RequestStateCodec<ConfirmationState>; key: string } | undefined;

/**
 * Derive the 32-byte HMAC key from WRANGL_SECRET_KEY, domain-separated from
 * the credential vault's key (different scrypt salt) so the two never
 * collide even when operators reuse one secret for both.
 */
function deriveKey(secret: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(secret)) return Buffer.from(secret, "hex");
  if (/^[A-Za-z0-9+/]{43}=?$/.test(secret)) {
    const buf = Buffer.from(secret, "base64");
    if (buf.length === 32) return buf;
  }
  return scryptSync(secret, "wrangl.confirm.v1", 32);
}

/**
 * The codec used to mint/verify confirmation `requestState`. Memoized on the
 * configured secret so repeated calls (one per tool registration) share one
 * instance. Falls back to a random per-process key when WRANGL_SECRET_KEY is
 * unset — confirmations still work for a single local process (e.g.
 * `wrangl generate`) but won't survive a restart or work across control-plane
 * replicas; operators are warned once.
 */
export function confirmationCodec(
  env: NodeJS.ProcessEnv = process.env,
): RequestStateCodec<ConfirmationState> {
  const secret = env.WRANGL_SECRET_KEY ?? "";
  if (cached && cached.key === secret) return cached.codec;

  if (!secret && !warnedNoSecret) {
    console.error(
      "⚠ WRANGL_SECRET_KEY is not set — destructive-action confirmations are " +
        "signed with a random per-process key. Fine for a single local process; " +
        "set WRANGL_SECRET_KEY for the hosted control plane or restarts to keep working.",
    );
    warnedNoSecret = true;
  }

  const codec = createRequestStateCodec<ConfirmationState>({
    key: secret ? deriveKey(secret) : randomBytes(32),
    ttlSeconds: CONFIRM_TTL_SECONDS,
    // Domain-separates confirmation state from any other MRTR flow a future
    // feature might add on the same server.
    bind: () => "wrangl.confirm",
  });
  cached = { codec, key: secret };
  return codec;
}

/** Stable digest of a tool call's arguments, order-independent. */
export function digestArgs(args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(sortKeysDeep(args)))
    .digest("hex")
    .slice(0, 16);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    );
  }
  return value;
}
