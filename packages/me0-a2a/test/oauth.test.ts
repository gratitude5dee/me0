import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Me0Engine, type OperationContext, type Store, connect, ensureCollections } from "me0-core";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  type A2AOAuthOptions,
  type A2AServerOptions,
  MEMORY_PROFILE_EXTENSION_URI,
  assertSafeUrl,
  handleA2ARequest,
} from "../src/index.js";

let mongod: MongoMemoryServer;
let store: Store;

const ctx: OperationContext = {
  user_id: "u_oauth",
  harness: "other",
  agent: "oauth-test",
  episode_id: null,
  remote: false,
};

const ISSUER = "https://idp.test";
const AUDIENCE = "https://me0.test";

// mutable JWKS served by the in-test HTTP server — lets tests rotate keys
let servedKeys: Array<Record<string, unknown>> = [];
let jwksServer: ReturnType<typeof Bun.serve>;
let jwksUri: string;

let keyA: Awaited<ReturnType<typeof generateKeyPair>>;
let keyB: Awaited<ReturnType<typeof generateKeyPair>>;
let rogueKey: Awaited<ReturnType<typeof generateKeyPair>>;

async function jwkOf(pair: Awaited<ReturnType<typeof generateKeyPair>>, kid: string) {
  return { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };
}

interface MintOptions {
  key?: Awaited<ReturnType<typeof generateKeyPair>>;
  kid?: string;
  scope?: string;
  sub?: string;
  aud?: string;
  iss?: string;
  exp?: string | number;
  nbf?: string | number;
}

async function mint(o: MintOptions = {}): Promise<string> {
  const pair = o.key ?? keyA;
  let jwt = new SignJWT({ ...(o.scope !== undefined ? { scope: o.scope } : {}) })
    .setProtectedHeader({ alg: "RS256", kid: o.kid ?? "kid-a" })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? AUDIENCE)
    .setSubject(o.sub ?? "agent-123")
    .setIssuedAt()
    .setExpirationTime(o.exp ?? "5m");
  if (o.nbf !== undefined) jwt = jwt.setNotBefore(o.nbf);
  return jwt.sign(pair.privateKey);
}

type FreshOverrides = Partial<Omit<A2AServerOptions, "oauth">> & {
  oauth?: Partial<A2AOAuthOptions>;
};

function freshOpts(overrides: FreshOverrides = {}): A2AServerOptions {
  // fresh oauth object per call → fresh verifier + JWKS cache
  const oauth: A2AOAuthOptions = {
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUri,
    jwksCooldownMs: 0,
    ...(overrides.oauth ?? {}),
  };
  return { userId: ctx.user_id, port: 4160, ...overrides, oauth };
}

function rpc(token?: string, parts?: unknown[]): Request {
  return new Request("http://localhost:4160/", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: { parts: parts ?? [{ kind: "text", text: "themes" }] } },
    }),
  });
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  store = await connect(mongod.getUri());
  await ensureCollections(store.db);
  const engine = new Me0Engine(store.db);
  await engine.remember(ctx, {
    text: "public: prefers light themes",
    kind: "preference",
    tier: "standing",
    visibility: "world",
  });

  keyA = await generateKeyPair("RS256");
  keyB = await generateKeyPair("RS256");
  rogueKey = await generateKeyPair("RS256");
  servedKeys = [await jwkOf(keyA, "kid-a")];
  jwksServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/jwks") return Response.json({ keys: servedKeys });
      const origin = new URL(req.url).origin;
      if (path === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: origin,
          jwks_uri: jwksUri,
          token_endpoint: `${origin}/oauth/token`,
        });
      }
      if (path === "/mismatch/.well-known/oauth-authorization-server") {
        return Response.json({ issuer: "https://someone-else.test", jwks_uri: jwksUri });
      }
      if (path === "/insecure/.well-known/oauth-authorization-server") {
        return Response.json({ issuer: `${origin}/insecure`, jwks_uri: "http://evil.test/jwks" });
      }
      if (path === "/insecure-token/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: `${origin}/insecure-token`,
          jwks_uri: jwksUri,
          token_endpoint: "http://evil.test/oauth/token",
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  jwksUri = `http://127.0.0.1:${jwksServer.port}/jwks`;
});

afterAll(async () => {
  jwksServer.stop(true);
  await store.close();
  await mongod.stop();
});

describe("a2a oauth", () => {
  test("valid token with me0.recall scope is accepted; sub audited", async () => {
    const token = await mint({ scope: "me0.recall", sub: "agent-xyz" });
    const res = await handleA2ARequest(store.db, freshOpts(), rpc(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: unknown };
    expect(body.result).toBeDefined();
    const auditRec = await store.db
      .collection("audit")
      .findOne({ "actor.sub": "agent-xyz", op: "a2a.memory.recall" });
    expect(auditRec).not.toBeNull();
    expect(auditRec?.actor.remote).toBe(true);
  });

  test("missing token gets 401 with a bare WWW-Authenticate challenge", async () => {
    const res = await handleA2ARequest(store.db, freshOpts(), rpc());
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="me0"');
  });

  test("expired token is rejected with invalid_token challenge", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await mint({ scope: "me0.recall", exp: past });
    const res = await handleA2ARequest(store.db, freshOpts(), rpc(token));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(await res.text()).toBe("unauthorized");
  });

  test("nbf in the future is rejected", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = await mint({ scope: "me0.recall", nbf: future });
    const res = await handleA2ARequest(store.db, freshOpts(), rpc(token));
    expect(res.status).toBe(401);
  });

  test("wrong audience is rejected", async () => {
    const token = await mint({ scope: "me0.recall", aud: "https://other.test" });
    const res = await handleA2ARequest(store.db, freshOpts(), rpc(token));
    expect(res.status).toBe(401);
  });

  test("wrong issuer is rejected", async () => {
    const token = await mint({ scope: "me0.recall", iss: "https://evil.test" });
    const res = await handleA2ARequest(store.db, freshOpts(), rpc(token));
    expect(res.status).toBe(401);
  });

  test("wrong signature (rogue key, known kid) is rejected", async () => {
    const token = await mint({ scope: "me0.recall", key: rogueKey, kid: "kid-a" });
    const res = await handleA2ARequest(store.db, freshOpts(), rpc(token));
    expect(res.status).toBe(401);
  });

  test("unknown kid fails, then succeeds after key rotation (JWKS refetch)", async () => {
    const opts = freshOpts();
    // prime the JWKS cache with only kid-a
    const primeRes = await handleA2ARequest(
      store.db,
      opts,
      rpc(await mint({ scope: "me0.recall" })),
    );
    expect(primeRes.status).toBe(200);
    const rotated = await mint({ scope: "me0.recall", key: keyB, kid: "kid-b" });
    const before = await handleA2ARequest(store.db, opts, rpc(rotated));
    expect(before.status).toBe(401);
    // rotate: publish kid-b, the verifier refetches on the unknown kid
    servedKeys = [await jwkOf(keyA, "kid-a"), await jwkOf(keyB, "kid-b")];
    const after = await handleA2ARequest(store.db, opts, rpc(rotated));
    expect(after.status).toBe(200);
    servedKeys = [await jwkOf(keyA, "kid-a")];
  });

  test("missing scope gets a 403 JSON-RPC error with insufficient_scope", async () => {
    const token = await mint({ scope: "openid profile" });
    const res = await handleA2ARequest(store.db, freshOpts(), rpc(token));
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(res.headers.get("www-authenticate")).toContain('scope="me0.recall"');
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32003);
    expect(body.error.message).toBe("insufficient scope");
  });

  test("memory-profile extension requires me0.profile", async () => {
    const parts = [{ kind: "data", data: { extension: MEMORY_PROFILE_EXTENSION_URI } }];
    const denied = await handleA2ARequest(
      store.db,
      freshOpts(),
      rpc(await mint({ scope: "me0.recall" }), parts),
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get("www-authenticate")).toContain('scope="me0.profile"');
    const allowed = await handleA2ARequest(
      store.db,
      freshOpts(),
      rpc(await mint({ scope: "me0.profile" }), parts),
    );
    expect(allowed.status).toBe(200);
  });

  test("static token still works in either mode; sub not set", async () => {
    const opts = freshOpts({ token: "sekrit" });
    const viaStatic = await handleA2ARequest(store.db, opts, rpc("sekrit"));
    expect(viaStatic.status).toBe(200);
    const viaJwt = await handleA2ARequest(store.db, opts, rpc(await mint({ scope: "me0.recall" })));
    expect(viaJwt.status).toBe(200);
  });

  test("oauth mode rejects the static token even when configured", async () => {
    const opts = freshOpts({ token: "sekrit", authMode: "oauth" });
    const res = await handleA2ARequest(store.db, opts, rpc("sekrit"));
    expect(res.status).toBe(401);
  });

  test("token mode ignores JWTs", async () => {
    const opts = freshOpts({ token: "sekrit", authMode: "token" });
    const res = await handleA2ARequest(store.db, opts, rpc(await mint({ scope: "me0.recall" })));
    expect(res.status).toBe(401);
    const ok = await handleA2ARequest(store.db, opts, rpc("sekrit"));
    expect(ok.status).toBe(200);
  });

  test("bearer scheme is case-insensitive for JWTs", async () => {
    const token = await mint({ scope: "me0.recall" });
    const req = new Request("http://localhost:4160/", {
      method: "POST",
      headers: { authorization: `BEARER ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: { parts: [{ kind: "text", text: "themes" }] } },
      }),
    });
    const res = await handleA2ARequest(store.db, freshOpts(), req);
    expect(res.status).toBe(200);
  });

  test("bearer scheme is case-insensitive for the static token", async () => {
    const opts = freshOpts({ token: "sekrit", authMode: "token" });
    const req = new Request("http://localhost:4160/", {
      method: "POST",
      headers: { authorization: "bearer sekrit" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: { parts: [{ kind: "text", text: "themes" }] } },
      }),
    });
    const res = await handleA2ARequest(store.db, opts, req);
    expect(res.status).toBe(200);
  });

  test("jwks discovery via well-known metadata works", async () => {
    const opts = freshOpts();
    if (opts.oauth) {
      opts.oauth.issuer = `http://127.0.0.1:${jwksServer.port}`;
      opts.oauth.jwksUri = undefined;
    }
    const token = await mint({
      scope: "me0.recall",
      iss: `http://127.0.0.1:${jwksServer.port}`,
    });
    const res = await handleA2ARequest(store.db, opts, rpc(token));
    expect(res.status).toBe(200);
  });

  test("discovery rejects metadata whose issuer does not match", async () => {
    const issuer = `http://127.0.0.1:${jwksServer.port}/mismatch`;
    const opts = freshOpts();
    if (opts.oauth) {
      opts.oauth.issuer = issuer;
      opts.oauth.jwksUri = undefined;
    }
    const token = await mint({ scope: "me0.recall", iss: issuer });
    const res = await handleA2ARequest(store.db, opts, rpc(token));
    expect(res.status).toBe(401);
  });

  test("discovery rejects a non-https jwks_uri on a non-loopback host", async () => {
    const issuer = `http://127.0.0.1:${jwksServer.port}/insecure`;
    const opts = freshOpts();
    if (opts.oauth) {
      opts.oauth.issuer = issuer;
      opts.oauth.jwksUri = undefined;
    }
    const token = await mint({ scope: "me0.recall", iss: issuer });
    const res = await handleA2ARequest(store.db, opts, rpc(token));
    expect(res.status).toBe(401);
  });

  test("non-https issuer on a non-loopback host is rejected outright", async () => {
    const opts = freshOpts();
    if (opts.oauth) {
      opts.oauth.issuer = "http://evil.test";
      opts.oauth.jwksUri = undefined;
    }
    const token = await mint({ scope: "me0.recall", iss: "http://evil.test" });
    const res = await handleA2ARequest(store.db, opts, rpc(token));
    expect(res.status).toBe(401);
  });

  test("agent card uses the discovered token_endpoint", async () => {
    const issuer = `http://127.0.0.1:${jwksServer.port}`;
    const opts = freshOpts();
    if (opts.oauth) {
      opts.oauth.issuer = issuer;
      opts.oauth.jwksUri = undefined;
    }
    const res = await handleA2ARequest(
      store.db,
      opts,
      new Request("http://localhost:4160/.well-known/agent-card.json"),
    );
    const card = (await res.json()) as {
      securitySchemes: { oauth2?: { flows?: { clientCredentials?: { tokenUrl?: string } } } };
    };
    expect(card.securitySchemes.oauth2?.flows?.clientCredentials?.tokenUrl).toBe(
      `${issuer}/oauth/token`,
    );
  });

  test("insecure discovered token_endpoint is dropped (flow omitted, jwks still used)", async () => {
    const issuer = `http://127.0.0.1:${jwksServer.port}/insecure-token`;
    const opts = freshOpts();
    if (opts.oauth) {
      opts.oauth.issuer = issuer;
      opts.oauth.jwksUri = undefined;
    }
    const res = await handleA2ARequest(
      store.db,
      opts,
      new Request("http://localhost:4160/.well-known/agent-card.json"),
    );
    const card = (await res.json()) as {
      securitySchemes: { oauth2?: { flows?: Record<string, unknown> } };
    };
    expect(card.securitySchemes.oauth2?.flows).toEqual({});
    // the safe jwks_uri is still used: token verification keeps working
    const token = await mint({ scope: "me0.recall", iss: issuer });
    const verified = await handleA2ARequest(store.db, opts, rpc(token));
    expect(verified.status).toBe(200);
  });

  test("agent card omits the token flow when no endpoint is known", async () => {
    const issuer = `http://127.0.0.1:${jwksServer.port}/nometa`;
    const opts = freshOpts();
    if (opts.oauth) {
      opts.oauth.issuer = issuer;
      opts.oauth.jwksUri = undefined;
    }
    const res = await handleA2ARequest(
      store.db,
      opts,
      new Request("http://localhost:4160/.well-known/agent-card.json"),
    );
    const card = (await res.json()) as {
      securitySchemes: { oauth2?: { type: string; flows?: Record<string, unknown> } };
    };
    expect(card.securitySchemes.oauth2?.type).toBe("oauth2");
    expect(card.securitySchemes.oauth2?.flows).toEqual({});
  });

  test("agent card advertises the oauth2 scheme alongside the static token", async () => {
    const res = await handleA2ARequest(
      store.db,
      freshOpts({ token: "sekrit", oauth: { tokenUrl: `${ISSUER}/oauth/token` } }),
      new Request("http://localhost:4160/.well-known/agent-card.json"),
    );
    const card = (await res.json()) as {
      securitySchemes: Record<string, { type: string; flows?: Record<string, unknown> }>;
      security: Array<Record<string, string[]>>;
    };
    expect(card.securitySchemes.bearer?.type).toBe("http");
    expect(card.securitySchemes.oauth2?.type).toBe("oauth2");
    const flows = card.securitySchemes.oauth2?.flows as {
      clientCredentials: { scopes: Record<string, string> };
    };
    expect(Object.keys(flows.clientCredentials.scopes).sort()).toEqual([
      "me0.profile",
      "me0.recall",
    ]);
    expect(card.security.some((s) => "oauth2" in s)).toBe(true);
  });
});

describe("assertSafeUrl loopback gating", () => {
  test("loopback http allowed only when the exemption applies", () => {
    expect(assertSafeUrl("http://127.0.0.1:9/jwks", "jwks_uri").href).toContain("127.0.0.1");
    expect(assertSafeUrl("http://[::1]:9/jwks", "jwks_uri", true)).toBeDefined();
    // metadata from a non-loopback issuer cannot point at loopback services
    expect(() => assertSafeUrl("http://127.0.0.1:9/jwks", "jwks_uri", false)).toThrow(/https/);
    expect(() => assertSafeUrl("http://127.8.8.8:9/jwks", "jwks_uri", false)).toThrow(/https/);
    expect(() => assertSafeUrl("http://[::1]:9/jwks", "jwks_uri", false)).toThrow(/https/);
  });

  test("https is always accepted; non-loopback http always rejected", () => {
    expect(assertSafeUrl("https://idp.test/jwks", "jwks_uri", false)).toBeDefined();
    expect(() => assertSafeUrl("http://internal.test/jwks", "jwks_uri", true)).toThrow(/https/);
  });
});
