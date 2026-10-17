import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
} from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

// Who the mock signs in at its authorization endpoint: the claims its
// UserInfo endpoint answers with.
export interface MockIdentity {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  groups?: string[];
}

export interface MockProvider {
  issuer: URL;
  clientId: string;
  clientSecret: string;
  // The identity the next authorization request signs in as.
  signInAs(identity: MockIdentity): void;
  // Answers the next authorization request with error=access_denied.
  denyNext(): void;
  // Signs the next ID token with a key that is not in the JWKS, under the
  // JWKS's own kid or under one of its own.
  forgeNext(kid: "same" | "unknown"): void;
  // Replaces the signing key and the JWKS with a new key under a new kid.
  rotateKey(): void;
  // Every path requested, in order.
  requests: string[];
  close(): Promise<void>;
}

// A standards-only OIDC provider on a loopback port, so the tests need no
// network: discovery, JWKS, authorization, token and UserInfo endpoints.
// The endpoints sit at paths no convention would guess, so a client can
// only find them through discovery. The token endpoint checks the client
// secret, redirect URI and PKCE verifier and takes each code once. The ID
// token carries only iss, sub, aud, nonce and times, so profile claims can
// only come from UserInfo. It is signed with RS256 under a kid the JWKS
// lists.
export async function startMockProvider(): Promise<MockProvider> {
  const clientId = "foodie-test";
  const clientSecret = randomBytes(16).toString("base64url");
  let generation = 0;
  let key = signingKey(`test-key-${generation}`);
  let forge: "same" | "unknown" | null = null;

  let next: MockIdentity | "deny" | null = null;
  const codes = new Map<
    string,
    {
      identity: MockIdentity;
      nonce: string | null;
      challenge: string;
      redirectUri: string;
    }
  >();
  const accessTokens = new Map<string, MockIdentity>();
  const requests: string[] = [];

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, issuer);
      requests.push(url.pathname);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const at = (path: string) => new URL(path, issuer).href;

      if (url.pathname === "/.well-known/openid-configuration") {
        return json(200, {
          issuer: issuerId,
          authorization_endpoint: at("/mock/authorize"),
          token_endpoint: at("/mock/token"),
          userinfo_endpoint: at("/mock/userinfo"),
          jwks_uri: at("/mock/jwks"),
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: [
            "client_secret_basic",
            "client_secret_post",
          ],
          scopes_supported: ["openid", "profile", "email"],
        });
      }

      if (url.pathname === "/mock/jwks") return json(200, { keys: [key.jwk] });

      if (url.pathname === "/mock/authorize") {
        const q = url.searchParams;
        const identity = next;
        next = null;
        if (
          q.get("client_id") !== clientId ||
          q.get("response_type") !== "code" ||
          q.get("code_challenge_method") !== "S256" ||
          !q.get("code_challenge") ||
          !q.get("scope")?.split(" ").includes("openid") ||
          !q.get("redirect_uri") ||
          identity === null
        ) {
          return json(400, { error: "invalid_request" });
        }
        const back = new URL(q.get("redirect_uri")!);
        if (q.get("state")) back.searchParams.set("state", q.get("state")!);
        if (identity === "deny") {
          back.searchParams.set("error", "access_denied");
        } else {
          const code = randomBytes(16).toString("base64url");
          codes.set(code, {
            identity,
            nonce: q.get("nonce"),
            challenge: q.get("code_challenge")!,
            redirectUri: q.get("redirect_uri")!,
          });
          back.searchParams.set("code", code);
        }
        res.writeHead(302, { location: back.href });
        return res.end();
      }

      if (url.pathname === "/mock/token" && req.method === "POST") {
        const form = new URLSearchParams(await readBody(req));
        const [id, secret] = clientCredentials(req, form);
        if (id !== clientId || !sameText(secret, clientSecret)) {
          return json(401, { error: "invalid_client" });
        }
        const code = form.get("code") ?? "";
        const grant = codes.get(code);
        codes.delete(code);
        const verifier = form.get("code_verifier") ?? "";
        if (
          form.get("grant_type") !== "authorization_code" ||
          !grant ||
          grant.redirectUri !== form.get("redirect_uri") ||
          createHash("sha256").update(verifier).digest("base64url") !==
            grant.challenge
        ) {
          return json(400, { error: "invalid_grant" });
        }
        const now = Math.floor(Date.now() / 1000);
        const signer =
          forge === null
            ? key
            : signingKey(forge === "same" ? key.kid : "not-in-the-jwks");
        forge = null;
        const idToken = signJwt(
          {
            iss: issuerId,
            sub: grant.identity.sub,
            aud: clientId,
            iat: now,
            exp: now + 300,
            ...(grant.nonce === null ? {} : { nonce: grant.nonce }),
          },
          signer.kid,
          (data) => sign("sha256", data, signer.privateKey),
        );
        const accessToken = randomBytes(16).toString("base64url");
        accessTokens.set(accessToken, grant.identity);
        return json(200, {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 300,
          id_token: idToken,
        });
      }

      if (url.pathname === "/mock/userinfo") {
        const token = req.headers.authorization?.replace(/^Bearer /, "");
        const identity = token ? accessTokens.get(token) : undefined;
        if (!identity) return json(401, { error: "invalid_token" });
        return json(200, identity);
      }

      json(404, { error: "not_found" });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const issuer = new URL(`http://127.0.0.1:${port}/`);
  // The issuer identifier as discovery and the ID token state it.
  const issuerId = `http://127.0.0.1:${port}`;

  return {
    issuer: new URL(issuerId),
    clientId,
    clientSecret,
    signInAs: (identity) => {
      next = identity;
    },
    denyNext: () => {
      next = "deny";
    },
    forgeNext: (kid) => {
      forge = kid;
    },
    rotateKey: () => {
      generation += 1;
      key = signingKey(`test-key-${generation}`);
    },
    requests,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function signingKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256" };
  return { kid, privateKey, jwk };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// From client_secret_basic or client_secret_post.
function clientCredentials(
  req: IncomingMessage,
  form: URLSearchParams,
): [string, string] {
  const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
  if (basic) {
    const [id = "", secret = ""] = Buffer.from(basic[1]!, "base64")
      .toString()
      .split(":")
      .map(decodeURIComponent);
    return [id, secret];
  }
  return [form.get("client_id") ?? "", form.get("client_secret") ?? ""];
}

function sameText(a: string, b: string): boolean {
  return (
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}

function signJwt(
  payload: object,
  kid: string,
  signer: (data: Buffer) => Buffer,
): string {
  const encode = (part: object) =>
    Buffer.from(JSON.stringify(part)).toString("base64url");
  const input = `${encode({ alg: "RS256", typ: "JWT", kid })}.${encode(payload)}`;
  return `${input}.${signer(Buffer.from(input)).toString("base64url")}`;
}
