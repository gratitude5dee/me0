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
  /** token endpoint advertised on the agent card; when omitted it is discovered */
  tokenUrl?: string;
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

const DISCOVERY_TIMEOUT_MS = 5_000;

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/** issuer-controlled URLs must be https (loopback exempt for local development) */
function assertSafeUrl(raw: string, what: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    throw new Error(`${what} must use https (got ${url.protocol}//${url.hostname})`);
  }
  return url;
}

interface IssuerMetadata {
  jwksUri?: string;
  tokenEndpoint?: string;
}

/**
 * RFC 8414 / OIDC discovery. The metadata document's `issuer` must equal the
 * configured issuer, and any URLs it points at must be same-scheme-safe —
 * a tampered document cannot redirect key fetching to an attacker host over
 * plaintext. Fetches are bounded by a timeout so a hanging IdP cannot stall
 * the request path.
 */
async function discoverIssuerMetadata(issuer: string): Promise<IssuerMetadata> {
  assertSafeUrl(issuer, "issuer");
  const base = issuer.replace(/\/$/, "");
  const candidates = [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
      if (!res.ok) continue;
      const meta = (await res.json()) as {
        issuer?: unknown;
        jwks_uri?: unknown;
        token_endpoint?: unknown;
      };
      if (typeof meta.issuer !== "string" || meta.issuer.replace(/\/$/, "") !== base) {
        continue; // metadata does not belong to the configured issuer
      }
      if (typeof meta.jwks_uri === "string" && meta.jwks_uri) {
        assertSafeUrl(meta.jwks_uri, "jwks_uri");
        let tokenEndpoint: string | undefined;
        if (typeof meta.token_endpoint === "string" && meta.token_endpoint) {
          assertSafeUrl(meta.token_endpoint, "token_endpoint");
          tokenEndpoint = meta.token_endpoint;
        }
        return { jwksUri: meta.jwks_uri, tokenEndpoint };
      }
    } catch {
      // try the next well-known location
    }
  }
  throw new Error(`could not discover jwks_uri from issuer ${issuer}`);
}

const DISCOVERY_FAILURE_TTL_MS = 30_000;

/**
 * Validates OAuth 2.1 Bearer JWT access tokens (resource-server role).
 * JWKS keys are cached; unknown `kid`s trigger a rate-capped refetch so
 * key rotation works without restarts (handled by jose's remote JWK set).
 * Verification fails closed: any error rejects the token.
 */
export class OAuthVerifier {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private metadata?: IssuerMetadata;
  private pendingDiscovery?: Promise<IssuerMetadata>;
  private discoveryFailedAt = 0;

  constructor(private readonly opts: A2AOAuthOptions) {}

  /**
   * Successful discovery is cached forever; failures are negative-cached for
   * a short TTL and concurrent lookups share one in-flight fetch, so anonymous
   * agent-card requests cannot amplify outbound traffic toward the issuer.
   */
  private async getMetadata(): Promise<IssuerMetadata> {
    if (this.metadata) return this.metadata;
    if (Date.now() - this.discoveryFailedAt < DISCOVERY_FAILURE_TTL_MS) {
      throw new Error("issuer metadata discovery recently failed");
    }
    if (!this.pendingDiscovery) {
      this.pendingDiscovery = discoverIssuerMetadata(this.opts.issuer);
    }
    try {
      this.metadata = await this.pendingDiscovery;
      return this.metadata;
    } catch (err) {
      this.discoveryFailedAt = Date.now();
      throw err;
    } finally {
      this.pendingDiscovery = undefined;
    }
  }

  private async getJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (!this.jwks) {
      const uri = this.opts.jwksUri
        ? assertSafeUrl(this.opts.jwksUri, "jwks_uri").href
        : (await this.getMetadata()).jwksUri;
      if (!uri) throw new Error("no jwks_uri available");
      this.jwks = createRemoteJWKSet(new URL(uri), {
        cacheMaxAge: this.opts.jwksCacheMaxAgeMs ?? 10 * 60_000,
        cooldownDuration: this.opts.jwksCooldownMs ?? 30_000,
      });
    }
    return this.jwks;
  }

  /**
   * token endpoint for the agent card: explicit config wins, then the
   * issuer's discovered `token_endpoint`; null when neither is available
   * (never guessed).
   */
  async tokenEndpoint(): Promise<string | null> {
    try {
      if (this.opts.tokenUrl) return assertSafeUrl(this.opts.tokenUrl, "token_url").href;
      return (await this.getMetadata()).tokenEndpoint ?? null;
    } catch {
      return null;
    }
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
