import { type JWTPayload, createRemoteJWKSet, jwtVerify } from "jose";

/** OAuth 2.1 scopes understood by the me0 A2A endpoint. */
export const SCOPE_RECALL = "me0.recall";
export const SCOPE_PROFILE = "me0.profile";

export const A2A_SCOPES: Record<string, string> = {
  [SCOPE_RECALL]: "Invoke the memory skills (recall, context_pack, synthesize)",
  [SCOPE_PROFILE]: "Request the redacted memory-profile pack extension",
};

export type A2AAuthMode = "token" | "oauth" | "either";

export interface A2AOAuthOptions {
  /** issuer URL — `iss` claim must match exactly */
  issuer: string;
  /** expected `aud` claim */
  audience: string;
  /** JWKS endpoint; when omitted it is discovered from the issuer's well-known metadata */
  jwksUri?: string;
  /** min interval between JWKS refetches on unknown kid (rate cap); default 30s */
  jwksCooldownMs?: number;
  /** how long a fetched JWKS is considered fresh; default 10min */
  jwksCacheMaxAgeMs?: number;
}

export interface VerifiedAccessToken {
  sub: string;
  scopes: Set<string>;
}

function parseScopes(payload: JWTPayload): Set<string> {
  const raw = payload.scope;
  if (typeof raw === "string") return new Set(raw.split(/\s+/).filter(Boolean));
  if (Array.isArray(raw)) return new Set(raw.filter((s): s is string => typeof s === "string"));
  return new Set();
}

async function discoverJwksUri(issuer: string): Promise<string> {
  const base = issuer.replace(/\/$/, "");
  const candidates = [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const meta = (await res.json()) as { jwks_uri?: unknown };
      if (typeof meta.jwks_uri === "string" && meta.jwks_uri) return meta.jwks_uri;
    } catch {
      // try the next well-known location
    }
  }
  throw new Error(`could not discover jwks_uri from issuer ${issuer}`);
}

/**
 * Validates OAuth 2.1 Bearer JWT access tokens (resource-server role).
 * JWKS keys are cached; unknown `kid`s trigger a rate-capped refetch so
 * key rotation works without restarts (handled by jose's remote JWK set).
 * Verification fails closed: any error rejects the token.
 */
export class OAuthVerifier {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly opts: A2AOAuthOptions) {}

  private async getJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (!this.jwks) {
      const uri = this.opts.jwksUri ?? (await discoverJwksUri(this.opts.issuer));
      this.jwks = createRemoteJWKSet(new URL(uri), {
        cacheMaxAge: this.opts.jwksCacheMaxAgeMs ?? 10 * 60_000,
        cooldownDuration: this.opts.jwksCooldownMs ?? 30_000,
      });
    }
    return this.jwks;
  }

  /** verify signature, iss, aud, exp, nbf; throws on any failure */
  async verify(token: string): Promise<VerifiedAccessToken> {
    const jwks = await this.getJwks();
    const { payload } = await jwtVerify(token, jwks, {
      issuer: this.opts.issuer,
      audience: this.opts.audience,
      algorithms: ["RS256", "ES256"],
    });
    return {
      sub: typeof payload.sub === "string" && payload.sub ? payload.sub : "unknown",
      scopes: parseScopes(payload),
    };
  }
}

const verifiers = new WeakMap<A2AOAuthOptions, OAuthVerifier>();

/** one verifier per config object so the JWKS cache survives across requests */
export function verifierFor(opts: A2AOAuthOptions): OAuthVerifier {
  let v = verifiers.get(opts);
  if (!v) {
    v = new OAuthVerifier(opts);
    verifiers.set(opts, v);
  }
  return v;
}
