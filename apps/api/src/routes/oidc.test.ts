import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { eq, sql } from "drizzle-orm";
import type { LightMyRequestResponse as Response } from "fastify";
import { afterAll, beforeAll, describe, expect, onTestFinished } from "vitest";
import { buildApp, logSerializers } from "../app.js";
import { createUser } from "../auth/accounts.js";
import { oidcProvider, type OidcProvider } from "../auth/oidc-provider.js";
import { oidcIdentity, oidcLogin, user } from "../db/schema.js";
import { dbTest, type TestTransaction } from "../test/db.js";
import {
  startMockProvider,
  type MockIdentity,
  type MockProvider,
} from "../test/oidc-provider-mock.js";
import { SESSION_COOKIE } from "./auth.js";
import { OIDC_COOKIE } from "./oidc.js";

const PASSWORD = "correct horse";
// As the browser reaches the api, through the web app's /api/ proxy.
const REDIRECT_URL = new URL("http://localhost:5173/api/auth/oidc/callback");
const unused = () => Promise.reject(new Error("not used by these tests"));

let mock: MockProvider;
beforeAll(async () => {
  mock = await startMockProvider();
});
afterAll(() => mock.close());

function provider(
  issuerUrl = mock.issuer,
  displayName: string | null = "Home SSO",
): OidcProvider {
  return oidcProvider({
    issuerUrl,
    clientId: mock.clientId,
    clientSecret: mock.clientSecret,
    redirectUrl: REDIRECT_URL,
    displayName,
  });
}

// Unique per test, so tests in other files never wait on these rows.
function email() {
  return `cook-${randomUUID()}@oidc-routes.test`;
}

function identity(overrides: Partial<MockIdentity> = {}): MockIdentity {
  return {
    sub: randomUUID(),
    email: email(),
    email_verified: true,
    name: "Sam Cook",
    ...overrides,
  };
}

type Cookies = Record<string, string>;

// The app on the test transaction, with its log lines collected.
function start(tx: TestTransaction, oidc: OidcProvider | null = provider()) {
  const logLines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logLines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      cb();
    },
  });
  const app = buildApp(
    {
      pingDatabase: () => Promise.resolve(),
      fetchPage: unused,
      loadUnits: unused,
      db: tx,
      secureCookies: true,
      settingsKey: Buffer.alloc(32),
      oidc,
    },
    // The server's serializers, so the request lines are as it logs them.
    { logger: { level: "info", stream, serializers: logSerializers } },
  );
  onTestFinished(() => app.close());

  const request = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    cookies: Cookies = {},
    payload?: object,
  ): Promise<Response> =>
    app.inject({
      method,
      url,
      cookies,
      ...(payload === undefined ? {} : { payload }),
    });

  // POST /auth/oidc/connect as the profile's HTML form submits it.
  const startConnect = (token?: string): Promise<Response> =>
    app.inject({
      method: "POST",
      url: "/auth/oidc/connect",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "",
      cookies: token ? { [SESSION_COOKIE]: token } : {},
    });

  // The callback path and query the provider last sent the browser to.
  let lastCallback = "";

  // Follows the provider's authorization endpoint, signed in there as `who`,
  // then brings the browser back to the callback with its cookies.
  async function throughProvider(
    authorizationUrl: string,
    cookies: Cookies,
    who: MockIdentity | "deny",
  ): Promise<Response> {
    if (who === "deny") mock.denyNext();
    else mock.signInAs(who);
    const res = await fetch(authorizationUrl, { redirect: "manual" });
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(REDIRECT_URL.href);
    lastCallback = `/auth/oidc/callback${back.search}`;
    return request("GET", lastCallback, cookies);
  }

  // GET /auth/oidc/start, then through the provider and back.
  async function oidcSignIn(who: MockIdentity | "deny") {
    const started = await request("GET", "/auth/oidc/start");
    expect(started.statusCode).toBe(302);
    return throughProvider(
      started.headers.location as string,
      { [OIDC_COOKIE]: cookieValue(started, OIDC_COOKIE) },
      who,
    );
  }

  // POST /auth/oidc/connect as the session, then through the provider.
  async function oidcConnect(token: string, who: MockIdentity) {
    const started = await startConnect(token);
    expect(started.statusCode).toBe(302);
    return throughProvider(
      started.headers.location as string,
      {
        [OIDC_COOKIE]: cookieValue(started, OIDC_COOKIE),
        [SESSION_COOKIE]: token,
      },
      who,
    );
  }

  async function login(address: string, password = PASSWORD) {
    return request("POST", "/auth/login", {}, { email: address, password });
  }

  // A local account, signed in.
  async function localAccount(address = email()) {
    const created = await createUser(tx, {
      email: address,
      password: PASSWORD,
    });
    if (!created) throw new Error("createUser returned null");
    const res = await login(address);
    return { ...created, token: cookieValue(res, SESSION_COOKIE) };
  }

  return {
    app,
    logLines,
    request,
    startConnect,
    oidcSignIn,
    oidcConnect,
    throughProvider,
    login,
    localAccount,
    lastCallback: () => lastCallback,
  };
}

function cookieValue(res: Response, name: string): string {
  const cookie = res.cookies.find((c) => c.name === name);
  if (!cookie) throw new Error(`no ${name} cookie in response`);
  return cookie.value;
}

// The url of each "incoming request" log line.
function requestUrls(logLines: Record<string, unknown>[]): string[] {
  return logLines
    .filter((l) => l.msg === "incoming request")
    .map((l) => (l.req as { url: string }).url);
}

function hasCookie(res: Response, name: string): boolean {
  return res.cookies.some((c) => c.name === name && c.value !== "");
}

async function accountsWithEmail(tx: TestTransaction, address: string) {
  return tx
    .select({
      id: user.id,
      passwordHash: user.passwordHash,
      isAdmin: user.isAdmin,
    })
    .from(user)
    .where(eq(sql`lower(${user.email})`, sql`lower(${address})`));
}

async function identitiesOf(tx: TestTransaction, userId: number) {
  return tx
    .select({ issuer: oidcIdentity.issuer, subject: oidcIdentity.subject })
    .from(oidcIdentity)
    .where(eq(oidcIdentity.userId, userId));
}

describe("GET /auth/oidc/config", () => {
  dbTest("says OIDC is on, with the display name", async ({ tx }) => {
    const { request } = start(tx);

    const res = await request("GET", "/auth/oidc/config");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, displayName: "Home SSO" });
  });

  dbTest("answers a null display name when none is set", async ({ tx }) => {
    const { request } = start(tx, provider(mock.issuer, null));

    const res = await request("GET", "/auth/oidc/config");

    expect(res.json()).toEqual({ enabled: true, displayName: null });
  });

  dbTest(
    "says OIDC is off, and the provider routes answer 404",
    async ({ tx }) => {
      const { request, localAccount } = start(tx, null);
      const cook = await localAccount();

      expect((await request("GET", "/auth/oidc/config")).json()).toEqual({
        enabled: false,
        displayName: null,
      });
      for (const [method, url] of [
        ["GET", "/auth/oidc/start"],
        ["GET", "/auth/oidc/callback?code=x&state=y"],
        ["POST", "/auth/oidc/connect"],
      ] as const) {
        const res = await request(method, url, {
          [SESSION_COOKIE]: cook.token,
        });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({
          error: "not_found",
          message: "oidc sign-in is not configured",
        });
      }
    },
  );
});

describe("GET /auth/oidc/start", () => {
  dbTest(
    "sends the browser to the discovered authorization endpoint with PKCE",
    async ({ tx }) => {
      const before = mock.requests.length;
      const { request } = start(tx, provider());

      const res = await request("GET", "/auth/oidc/start");

      expect(res.statusCode).toBe(302);
      const to = new URL(res.headers.location as string);
      expect(to.origin + to.pathname).toBe(
        `${mock.issuer.origin}/mock/authorize`,
      );
      expect(mock.requests.slice(before)).toEqual([
        "/.well-known/openid-configuration",
      ]);
      const q = to.searchParams;
      expect(q.get("response_type")).toBe("code");
      expect(q.get("client_id")).toBe(mock.clientId);
      expect(q.get("redirect_uri")).toBe(REDIRECT_URL.href);
      expect(q.get("scope")).toBe("openid profile email");
      expect(q.get("code_challenge_method")).toBe("S256");
      expect(q.get("code_challenge")).toMatch(/^[\w-]{43}$/);
      expect(q.get("state")).toMatch(/^[\w-]{20,}$/);
      expect(q.get("nonce")).toMatch(/^[\w-]{20,}$/);
      expect(res.cookies.find((c) => c.name === OIDC_COOKIE)).toMatchObject({
        httpOnly: true,
        sameSite: "Lax",
        secure: true,
        path: "/api/auth/oidc/callback",
      });
      // The trip, not the session, holds the state and verifier.
      expect(hasCookie(res, SESSION_COOKIE)).toBe(false);
    },
  );

  dbTest(
    "sends the browser back to sign-in when the provider is down",
    async ({ tx }) => {
      const down = await startMockProvider();
      await down.close();
      const { request, logLines } = start(tx, provider(down.issuer));

      const res = await request("GET", "/auth/oidc/start");

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/sign-in?oidc_error=provider_error");
      expect(hasCookie(res, OIDC_COOKIE)).toBe(false);
      expect(await tx.select().from(oidcLogin)).toEqual([]);
      expect(logLines).toContainEqual(
        expect.objectContaining({ msg: "auth: oidc provider unavailable" }),
      );
    },
  );
});

describe("signing in through the provider", () => {
  // Criteria 1 and 2.
  dbTest(
    "creates an account with no password for a new email and signs it in",
    async ({ tx }) => {
      const { oidcSignIn, request } = start(tx);
      const who = identity({ name: "  Sam Cook  " });

      const res = await oidcSignIn(who);

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/");
      expect(res.cookies.find((c) => c.name === SESSION_COOKIE)).toMatchObject({
        httpOnly: true,
        sameSite: "Lax",
        secure: true,
        path: "/",
      });
      const me = await request("GET", "/me", {
        [SESSION_COOKIE]: cookieValue(res, SESSION_COOKIE),
      });
      expect(me.json()).toEqual({
        id: expect.any(Number) as number,
        email: who.email,
        displayName: "Sam Cook",
        locale: "en-GB",
        isAdmin: false,
        hasPassword: false,
        oidc: { connected: true, connectedAt: expect.any(String) as string },
      });
      const [account] = await accountsWithEmail(tx, who.email!);
      expect(account!.passwordHash).toBeNull();
      expect(await identitiesOf(tx, account!.id)).toEqual([
        { issuer: mock.issuer.origin, subject: who.sub },
      ]);
    },
  );

  // Criterion 3.
  dbTest(
    "links a verified email to the existing local account",
    async ({ tx }) => {
      const { oidcSignIn, localAccount, request, login } = start(tx);
      const local = await localAccount();

      const res = await oidcSignIn(
        identity({ email: local.email.toUpperCase(), email_verified: true }),
      );

      expect(res.headers.location).toBe("/");
      const me = await request("GET", "/me", {
        [SESSION_COOKIE]: cookieValue(res, SESSION_COOKIE),
      });
      expect(me.json()).toMatchObject({ id: local.id, email: local.email });
      expect(await accountsWithEmail(tx, local.email)).toHaveLength(1);
      expect(await identitiesOf(tx, local.id)).toHaveLength(1);
      // The local password still works.
      expect((await login(local.email)).statusCode).toBe(200);
    },
  );

  dbTest.for([
    ["false", false],
    ["absent", undefined],
  ] as const)(
    "refuses an existing email whose email_verified is %s",
    async ([, verified], { tx }) => {
      const { oidcSignIn, localAccount, logLines } = start(tx);
      const local = await localAccount();
      const who = identity({ email: local.email });
      if (verified === undefined) delete who.email_verified;
      else who.email_verified = verified;

      const res = await oidcSignIn(who);

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/sign-in?oidc_error=email_unverified");
      expect(hasCookie(res, SESSION_COOKIE)).toBe(false);
      expect(await accountsWithEmail(tx, local.email)).toHaveLength(1);
      expect(await identitiesOf(tx, local.id)).toEqual([]);
      expect(logLines.filter((l) => l.msg === "auth: sign-in failed")).toEqual([
        expect.objectContaining({
          level: 40,
          email: local.email,
          ip: "127.0.0.1",
        }),
      ]);
    },
  );

  dbTest(
    "refuses a verified email whose account has another identity from the provider",
    async ({ tx }) => {
      const { oidcConnect, oidcSignIn, localAccount } = start(tx);
      const local = await localAccount();
      const first = identity({ email: local.email });
      await oidcConnect(local.token, first);

      const res = await oidcSignIn(identity({ email: local.email }));

      expect(res.headers.location).toBe(
        "/sign-in?oidc_error=already_connected",
      );
      expect(hasCookie(res, SESSION_COOKIE)).toBe(false);
      expect(await identitiesOf(tx, local.id)).toEqual([
        { issuer: mock.issuer.origin, subject: first.sub },
      ]);
    },
  );

  // Criterion 5.
  dbTest(
    "lands the same identity in the same account every time, whatever its email becomes",
    async ({ tx }) => {
      const { oidcSignIn, request } = start(tx);
      const who = identity();
      const first = await oidcSignIn(who);
      const token = cookieValue(first, SESSION_COOKIE);
      const id = (
        await request("GET", "/me", { [SESSION_COOKIE]: token })
      ).json<{ id: number }>().id;
      await request(
        "PATCH",
        "/me",
        { [SESSION_COOKIE]: token },
        { displayName: "Edited in Foodie" },
      );

      const again = await oidcSignIn({
        ...who,
        email: email(),
        email_verified: false,
        name: "Changed at the provider",
      });

      const me = await request("GET", "/me", {
        [SESSION_COOKIE]: cookieValue(again, SESSION_COOKIE),
      });
      expect(me.json()).toMatchObject({
        id,
        email: who.email,
        displayName: "Edited in Foodie",
      });
    },
  );

  dbTest(
    "lands a linked identity in the local account it was linked to",
    async ({ tx }) => {
      const { oidcSignIn, localAccount, request } = start(tx);
      const local = await localAccount();
      const who = identity({ email: local.email });
      await oidcSignIn(who);

      const again = await oidcSignIn({ ...who, email: email() });

      const me = await request("GET", "/me", {
        [SESSION_COOKIE]: cookieValue(again, SESSION_COOKIE),
      });
      expect(me.json()).toMatchObject({ id: local.id });
    },
  );

  // Criterion 7.
  dbTest(
    "never grants or removes admin, whatever the groups claim says",
    async ({ tx }) => {
      const { oidcSignIn, request } = start(tx);
      const who = identity({ groups: ["admin", "admins", "foodie-admin"] });

      const first = await oidcSignIn(who);
      const me = (
        await request("GET", "/me", {
          [SESSION_COOKIE]: cookieValue(first, SESSION_COOKIE),
        })
      ).json<{ id: number; isAdmin: boolean }>();
      expect(me.isAdmin).toBe(false);

      await tx.update(user).set({ isAdmin: true }).where(eq(user.id, me.id));
      const again = await oidcSignIn({ ...who, groups: [] });
      expect(
        (
          await request("GET", "/me", {
            [SESSION_COOKIE]: cookieValue(again, SESSION_COOKIE),
          })
        ).json(),
      ).toMatchObject({ id: me.id, isAdmin: true });
    },
  );

  // Criterion 10.
  dbTest(
    "refuses a disabled account and creates no new one",
    async ({ tx }) => {
      const { oidcSignIn, logLines } = start(tx);
      const who = identity();
      await oidcSignIn(who);
      const [account] = await accountsWithEmail(tx, who.email!);
      await tx
        .update(user)
        .set({ disabledAt: new Date() })
        .where(eq(user.id, account!.id));

      const res = await oidcSignIn(who);

      expect(res.headers.location).toBe("/sign-in?oidc_error=account_disabled");
      expect(hasCookie(res, SESSION_COOKIE)).toBe(false);
      expect(await accountsWithEmail(tx, who.email!)).toHaveLength(1);
      expect(logLines).toContainEqual(
        expect.objectContaining({
          msg: "auth: sign-in failed",
          email: who.email,
          ip: "127.0.0.1",
        }),
      );
    },
  );

  dbTest(
    "refuses to link a verified email to a disabled local account",
    async ({ tx }) => {
      const { oidcSignIn, localAccount } = start(tx);
      const local = await localAccount();
      await tx
        .update(user)
        .set({ disabledAt: new Date() })
        .where(eq(user.id, local.id));

      const res = await oidcSignIn(identity({ email: local.email }));

      expect(res.headers.location).toBe("/sign-in?oidc_error=account_disabled");
      expect(await identitiesOf(tx, local.id)).toEqual([]);
    },
  );

  dbTest(
    "gives a deleted account's identity a fresh, empty account",
    async ({ tx }) => {
      const { oidcSignIn, request } = start(tx);
      const who = identity();
      await oidcSignIn(who);
      const [old] = await accountsWithEmail(tx, who.email!);
      await tx.delete(user).where(eq(user.id, old!.id));

      const res = await oidcSignIn(who);

      const me = (
        await request("GET", "/me", {
          [SESSION_COOKIE]: cookieValue(res, SESSION_COOKIE),
        })
      ).json<{ id: number }>();
      expect(me.id).not.toBe(old!.id);
    },
  );

  dbTest("refuses a new identity with no email", async ({ tx }) => {
    const { oidcSignIn } = start(tx);
    const who = identity();
    delete who.email;

    const res = await oidcSignIn(who);

    expect(res.headers.location).toBe("/sign-in?oidc_error=provider_error");
    expect(await tx.select().from(oidcIdentity)).toEqual([]);
  });
});

describe("GET /auth/oidc/callback", () => {
  dbTest(
    "uses a trip once: the same callback again answers provider_error",
    async ({ tx }) => {
      const { request, throughProvider, lastCallback } = start(tx);
      const started = await request("GET", "/auth/oidc/start");
      const cookies = { [OIDC_COOKIE]: cookieValue(started, OIDC_COOKIE) };
      const first = await throughProvider(
        started.headers.location as string,
        cookies,
        identity(),
      );
      expect(first.headers.location).toBe("/");

      const replay = await request("GET", lastCallback(), cookies);

      expect(replay.headers.location).toBe(
        "/sign-in?oidc_error=provider_error",
      );
      expect(hasCookie(replay, SESSION_COOKIE)).toBe(false);
    },
  );

  dbTest(
    "answers provider_error without the trip cookie, and clears it after use",
    async ({ tx }) => {
      const { request, throughProvider } = start(tx);
      const started = await request("GET", "/auth/oidc/start");

      const res = await throughProvider(
        started.headers.location as string,
        {},
        identity(),
      );

      expect(res.headers.location).toBe("/sign-in?oidc_error=provider_error");
      expect(hasCookie(res, SESSION_COOKIE)).toBe(false);
      expect(res.cookies.find((c) => c.name === OIDC_COOKIE)).toMatchObject({
        value: "",
        path: "/api/auth/oidc/callback",
      });
    },
  );

  dbTest(
    "answers provider_error once the trip has timed out",
    async ({ tx }) => {
      const { request, throughProvider } = start(tx);
      const started = await request("GET", "/auth/oidc/start");
      await tx
        .update(oidcLogin)
        .set({ expiresAt: new Date(Date.now() - 1000) });

      const res = await throughProvider(
        started.headers.location as string,
        { [OIDC_COOKIE]: cookieValue(started, OIDC_COOKIE) },
        identity(),
      );

      expect(res.headers.location).toBe("/sign-in?oidc_error=provider_error");
    },
  );

  dbTest(
    "refuses a callback started in another browser (state mismatch)",
    async ({ tx }) => {
      const { request, throughProvider, logLines } = start(tx);
      const mine = await request("GET", "/auth/oidc/start");
      const theirs = await request("GET", "/auth/oidc/start");

      // The other browser's provider response, with this browser's cookie.
      const res = await throughProvider(
        theirs.headers.location as string,
        { [OIDC_COOKIE]: cookieValue(mine, OIDC_COOKIE) },
        identity(),
      );

      expect(res.headers.location).toBe("/sign-in?oidc_error=provider_error");
      expect(hasCookie(res, SESSION_COOKIE)).toBe(false);
      expect(await tx.select().from(oidcIdentity)).toEqual([]);
      expect(logLines).toContainEqual(
        expect.objectContaining({ msg: "auth: oidc callback failed" }),
      );
    },
  );

  dbTest(
    "answers provider_error when the user turns the provider down",
    async ({ tx }) => {
      const { oidcSignIn } = start(tx);

      const res = await oidcSignIn("deny");

      expect(res.headers.location).toBe("/sign-in?oidc_error=provider_error");
      expect(hasCookie(res, SESSION_COOKIE)).toBe(false);
    },
  );

  dbTest("never logs the code, tokens or client secret", async ({ tx }) => {
    const { oidcSignIn, logLines, lastCallback } = start(tx);

    const res = await oidcSignIn(identity());

    const code = new URL(lastCallback(), "http://x").searchParams.get("code")!;
    const logged = JSON.stringify(logLines);
    expect(code).toBeTruthy();
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(mock.clientSecret);
    expect(logged).not.toContain(cookieValue(res, SESSION_COOKIE));
  });

  dbTest(
    "never logs the code when the callback path is percent-encoded",
    async ({ tx }) => {
      const { request, logLines } = start(tx);
      const started = await request("GET", "/auth/oidc/start");
      mock.signInAs(identity());
      const fromProvider = await fetch(started.headers.location as string, {
        redirect: "manual",
      });
      const back = new URL(fromProvider.headers.get("location")!);

      // %63 is "c": the router resolves this to the callback.
      const res = await request("GET", `/auth/oidc/%63allback${back.search}`, {
        [OIDC_COOKIE]: cookieValue(started, OIDC_COOKIE),
      });

      expect(res.headers.location).toBe("/");
      const code = back.searchParams.get("code")!;
      expect(code).toBeTruthy();
      expect(JSON.stringify(logLines)).not.toContain(code);
      expect(requestUrls(logLines)).toEqual([
        "/auth/oidc/start",
        "/auth/oidc/%63allback",
      ]);
    },
  );

  dbTest(
    "never logs the query of a path that matches no route",
    async ({ tx }) => {
      const { request, logLines } = start(tx);

      const res = await request(
        "GET",
        "/auth/oidc/callback/?code=LEAK_SENTINEL&state=x",
      );

      // The answer is Fastify's own 404, unchanged.
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        message:
          "Route GET:/auth/oidc/callback/?code=LEAK_SENTINEL&state=x not found",
        error: "Not Found",
        statusCode: 404,
      });
      expect(JSON.stringify(logLines)).not.toContain("LEAK_SENTINEL");
      expect(logLines).toContainEqual(
        expect.objectContaining({
          msg: "Route GET:/auth/oidc/callback/ not found",
        }),
      );
    },
  );

  dbTest("still logs the query of other routes", async ({ tx }) => {
    const { request, logLines } = start(tx);

    await request("GET", "/auth/oidc/config?from=test");

    expect(requestUrls(logLines)).toEqual(["/auth/oidc/config?from=test"]);
  });
});

// Criterion 4.
describe("POST /auth/login for an account with no password", () => {
  dbTest(
    "answers exactly as a wrong password does, after the same work",
    async ({ tx }) => {
      const { oidcSignIn, localAccount, login, request } = start(tx);
      const who = identity();
      await oidcSignIn(who);
      const local = await localAccount();

      const timed = async (address: string) => {
        const began = performance.now();
        const res = await login(address, "a guessed password");
        return { res, ms: performance.now() - began };
      };
      const oidcOnly: number[] = [];
      const wrong: number[] = [];
      let last: { a: Response; b: Response } | null = null;
      for (let i = 0; i < 5; i++) {
        const a = await timed(who.email!);
        const b = await timed(local.email);
        oidcOnly.push(a.ms);
        wrong.push(b.ms);
        last = { a: a.res, b: b.res };
      }

      expect(last!.a.statusCode).toBe(401);
      expect(last!.a.body).toBe(last!.b.body);
      expect(last!.a.headers["content-type"]).toBe(
        last!.b.headers["content-type"],
      );
      expect(hasCookie(last!.a, SESSION_COOKIE)).toBe(false);
      // Both run one argon2 verification, tens of milliseconds; skipping it
      // would take well under one. A generous band, so load cannot flake it.
      const median = (xs: number[]) => xs.sort((x, y) => x - y)[2]!;
      const ratio = median(oidcOnly) / median(wrong);
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(2);

      // And the profile has no way to set a password.
      const token = cookieValue(await oidcSignIn(who), SESSION_COOKIE);
      const patch = await request(
        "PATCH",
        "/me",
        { [SESSION_COOKIE]: token },
        { password: "a new password" },
      );
      expect(patch.statusCode).toBe(400);
      expect(patch.json()).toEqual({
        error: "invalid_request",
        message: "unknown field: password",
      });
    },
  );
});

// Criterion 6.
describe("connecting an identity from the profile", () => {
  dbTest(
    "links an identity whose email matches in any case, and signs in with it",
    async ({ tx }) => {
      const { oidcConnect, oidcSignIn, localAccount, request } = start(tx);
      const local = await localAccount();
      const who = identity({
        email: local.email.toUpperCase(),
        email_verified: false,
      });

      const res = await oidcConnect(local.token, who);

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/profile?oidc=connected");
      expect(await identitiesOf(tx, local.id)).toEqual([
        { issuer: mock.issuer.origin, subject: who.sub },
      ]);
      const me = (
        await request("GET", "/me", { [SESSION_COOKIE]: local.token })
      ).json<{ hasPassword: boolean; oidc: { connectedAt: string } }>();
      expect(me).toMatchObject({
        hasPassword: true,
        oidc: { connected: true },
      });
      const [row] = await tx
        .select({ createdAt: oidcIdentity.createdAt })
        .from(oidcIdentity)
        .where(eq(oidcIdentity.userId, local.id));
      expect(me.oidc.connectedAt).toBe(row!.createdAt.toISOString());

      const signedIn = await oidcSignIn(who);
      expect(
        (
          await request("GET", "/me", {
            [SESSION_COOKIE]: cookieValue(signedIn, SESSION_COOKIE),
          })
        ).json(),
      ).toMatchObject({ id: local.id });
    },
  );

  dbTest("connecting the same identity again succeeds", async ({ tx }) => {
    const { oidcConnect, localAccount } = start(tx);
    const local = await localAccount();
    const who = identity({ email: local.email });
    await oidcConnect(local.token, who);

    const res = await oidcConnect(local.token, who);

    expect(res.headers.location).toBe("/profile?oidc=connected");
    expect(await identitiesOf(tx, local.id)).toHaveLength(1);
  });

  dbTest.for([
    ["a different email", "someone-else@oidc-routes.test"],
    ["no email", null],
  ] as const)("refuses %s", async ([, address], { tx }) => {
    const { oidcConnect, localAccount, logLines } = start(tx);
    const local = await localAccount();
    const who = identity();
    if (address === null) delete who.email;
    else who.email = address;

    const res = await oidcConnect(local.token, who);

    expect(res.headers.location).toBe("/profile?oidc_error=email_mismatch");
    expect(await identitiesOf(tx, local.id)).toEqual([]);
    expect(logLines).toContainEqual(
      expect.objectContaining({
        msg: "auth: oidc connect refused",
        userId: local.id,
        reason: "email_mismatch",
      }),
    );
  });

  dbTest(
    "refuses an identity that signs in to another account",
    async ({ tx }) => {
      const { oidcConnect, oidcSignIn, localAccount } = start(tx);
      const who = identity();
      await oidcSignIn(who);
      const local = await localAccount();

      const res = await oidcConnect(local.token, {
        ...who,
        email: local.email,
      });

      expect(res.headers.location).toBe(
        "/profile?oidc_error=already_connected",
      );
      expect(await identitiesOf(tx, local.id)).toEqual([]);
    },
  );

  dbTest("refuses a second identity from the same provider", async ({ tx }) => {
    const { oidcConnect, localAccount } = start(tx);
    const local = await localAccount();
    const first = identity({ email: local.email });
    await oidcConnect(local.token, first);

    const res = await oidcConnect(
      local.token,
      identity({ email: local.email }),
    );

    expect(res.headers.location).toBe("/profile?oidc_error=already_connected");
    expect(await identitiesOf(tx, local.id)).toEqual([
      { issuer: mock.issuer.origin, subject: first.sub },
    ]);
  });

  dbTest(
    "refuses to finish when the browser is no longer signed in as the user",
    async ({ tx }) => {
      const { request, startConnect, throughProvider, localAccount } =
        start(tx);
      const local = await localAccount();
      const started = await startConnect(local.token);
      await request("POST", "/auth/logout", { [SESSION_COOKIE]: local.token });

      const res = await throughProvider(
        started.headers.location as string,
        {
          [OIDC_COOKIE]: cookieValue(started, OIDC_COOKIE),
          [SESSION_COOKIE]: local.token,
        },
        identity({ email: local.email }),
      );

      expect(res.headers.location).toBe("/profile?oidc_error=provider_error");
      expect(await identitiesOf(tx, local.id)).toEqual([]);
    },
  );

  dbTest("POST /auth/oidc/connect answers 401 signed out", async ({ tx }) => {
    const { startConnect } = start(tx);

    expect((await startConnect()).statusCode).toBe(401);
  });

  dbTest(
    "POST /auth/oidc/connect sends the browser back to the profile when the provider is down",
    async ({ tx }) => {
      const down = await startMockProvider();
      await down.close();
      const { startConnect, localAccount } = start(tx, provider(down.issuer));
      const local = await localAccount();

      const res = await startConnect(local.token);

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/profile?oidc_error=provider_error");
      expect(hasCookie(res, OIDC_COOKIE)).toBe(false);
    },
  );
});

describe("DELETE /auth/oidc/connection", () => {
  dbTest(
    "disconnects an account with a password, and repeating it is harmless",
    async ({ tx }) => {
      const { oidcConnect, oidcSignIn, localAccount, request } = start(tx);
      const local = await localAccount();
      const who = identity({ email: local.email });
      await oidcConnect(local.token, who);

      for (let i = 0; i < 2; i++) {
        const res = await request("DELETE", "/auth/oidc/connection", {
          [SESSION_COOKIE]: local.token,
        });
        expect(res.statusCode).toBe(204);
      }

      expect(await identitiesOf(tx, local.id)).toEqual([]);
      expect(
        (await request("GET", "/me", { [SESSION_COOKIE]: local.token })).json(),
      ).toMatchObject({
        hasPassword: true,
        oidc: { connected: false, connectedAt: null },
      });
      // Unverified, so the provider can no longer reach the account.
      const again = await oidcSignIn({ ...who, email_verified: false });
      expect(again.headers.location).toBe(
        "/sign-in?oidc_error=email_unverified",
      );
    },
  );

  dbTest("refuses an account with no password", async ({ tx }) => {
    const { oidcSignIn, request } = start(tx);
    const who = identity();
    const token = cookieValue(await oidcSignIn(who), SESSION_COOKIE);

    const res = await request("DELETE", "/auth/oidc/connection", {
      [SESSION_COOKIE]: token,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "no_local_password",
      message:
        "an account without a password cannot disconnect its sign-in provider",
    });
    const [account] = await accountsWithEmail(tx, who.email!);
    expect(await identitiesOf(tx, account!.id)).toHaveLength(1);
  });
});

// Criterion 10.
describe("admin actions on an account with no password", () => {
  dbTest(
    "refuse setting a password, and allow grant, revoke, disable and delete",
    async ({ tx }) => {
      const { oidcSignIn, localAccount, request } = start(tx);
      const admin = await localAccount();
      await tx.update(user).set({ isAdmin: true }).where(eq(user.id, admin.id));
      const who = identity();
      await oidcSignIn(who);
      const [account] = await accountsWithEmail(tx, who.email!);
      const id = account!.id;
      const asAdmin = { [SESSION_COOKIE]: admin.token };

      const listed = (await request("GET", "/admin/users", asAdmin)).json<{
        users: { id: number; hasPassword: boolean }[];
      }>();
      expect(listed.users.find((u) => u.id === id)).toMatchObject({
        hasPassword: false,
      });

      const password = await request(
        "PUT",
        `/admin/users/${id}/password`,
        asAdmin,
        { password: "set by the admin" },
      );
      expect(password.statusCode).toBe(409);
      expect(password.json()).toEqual({
        error: "password_not_allowed",
        message:
          "this account signs in through its OIDC provider and cannot have a password",
      });
      expect((await accountsWithEmail(tx, who.email!))[0]!.passwordHash).toBe(
        null,
      );

      for (const action of ["grant-admin", "revoke-admin", "disable"]) {
        const res = await request(
          "POST",
          `/admin/users/${id}/${action}`,
          asAdmin,
        );
        expect(res.statusCode).toBe(200);
      }
      expect(
        (await request("DELETE", `/admin/users/${id}`, asAdmin)).statusCode,
      ).toBe(204);
    },
  );
});
