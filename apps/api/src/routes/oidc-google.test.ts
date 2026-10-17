import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { LightMyRequestResponse as Response } from "fastify";
import { afterAll, beforeAll, describe, expect, onTestFinished } from "vitest";
import { buildApp } from "../app.js";
import { createUser } from "../auth/accounts.js";
import { oidcProvider, type OidcProvider } from "../auth/oidc-provider.js";
import type { OidcProviderId } from "../config.js";
import { oidcIdentity, user } from "../db/schema.js";
import { dbTest, type TestTransaction } from "../test/db.js";
import {
  startMockProvider,
  type MockIdentity,
  type MockProvider,
} from "../test/oidc-provider-mock.js";
import { SESSION_COOKIE } from "./auth.js";
import { OIDC_COOKIE } from "./oidc.js";

// Google beside the generic provider (NATG-291). Two mock providers, each on
// its own port and so its own issuer, stand in for the two: Google's issuer
// is fixed in config.ts, so only the provider built here points it at a
// mock.

const PASSWORD = "correct horse";
// As the browser reaches the api, through the web app's /api/ proxy.
const REDIRECT_URLS: Record<OidcProviderId, URL> = {
  generic: new URL("http://localhost:5173/api/auth/oidc/callback"),
  google: new URL("http://localhost:5173/api/auth/oidc/google/callback"),
};
// The api path each provider's redirect URL reaches.
const CALLBACK_ROUTES: Record<OidcProviderId, string> = {
  generic: "/auth/oidc/callback",
  google: "/auth/oidc/google/callback",
};
const unused = () => Promise.reject(new Error("not used by these tests"));

const mocks = {} as Record<OidcProviderId, MockProvider>;
beforeAll(async () => {
  mocks.generic = await startMockProvider();
  mocks.google = await startMockProvider();
});
afterAll(async () => {
  await mocks.generic.close();
  await mocks.google.close();
});

function provider(
  id: OidcProviderId,
  limits: { maxPendingLogins?: number; startsPerMinute?: number } = {},
): OidcProvider {
  const mock = mocks[id];
  return oidcProvider({
    id,
    issuerUrl: mock.issuer,
    clientId: mock.clientId,
    clientSecret: mock.clientSecret,
    redirectUrl: REDIRECT_URLS[id],
    displayName: id === "google" ? "Google" : "Home SSO",
    maxPendingLogins: limits.maxPendingLogins ?? 1000,
    startsPerMinute: limits.startsPerMinute ?? 10,
  });
}

function email() {
  return `cook-${randomUUID()}@oidc-google.test`;
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

function cookieValue(res: Response, name: string): string {
  const cookie = res.cookies.find((c) => c.name === name);
  if (!cookie) throw new Error(`no ${name} cookie in response`);
  return cookie.value;
}

// The app on the test transaction with the given providers configured.
function start(
  tx: TestTransaction,
  {
    generic = provider("generic"),
    google = provider("google"),
  }: { generic?: OidcProvider | null; google?: OidcProvider | null } = {},
) {
  const app = buildApp({
    pingDatabase: () => Promise.resolve(),
    fetchPage: unused,
    loadUnits: unused,
    db: tx,
    secureCookies: true,
    settingsKey: Buffer.alloc(32),
    oidc: generic,
    google,
  });
  onTestFinished(() => app.close());

  const request = (
    method: "GET" | "POST" | "DELETE",
    url: string,
    cookies: Cookies = {},
  ): Promise<Response> => app.inject({ method, url, cookies });

  // Follows the provider's authorization endpoint, signed in there as `who`,
  // then brings the browser back to that provider's callback.
  async function throughProvider(
    id: OidcProviderId,
    started: Response,
    who: MockIdentity,
    cookies: Cookies = {},
  ): Promise<Response> {
    expect(started.statusCode).toBe(302);
    mocks[id].signInAs(who);
    const res = await fetch(started.headers.location as string, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(REDIRECT_URLS[id].href);
    return request("GET", `${CALLBACK_ROUTES[id]}${back.search}`, {
      ...cookies,
      [OIDC_COOKIE]: cookieValue(started, OIDC_COOKIE),
    });
  }

  // Signs in through a provider, starting at /auth/oidc/<id>/start or, for
  // `startPath`, wherever it says.
  async function oidcSignIn(
    id: OidcProviderId,
    who: MockIdentity,
    startPath = `/auth/oidc/${id}/start`,
  ) {
    return throughProvider(id, await request("GET", startPath), who);
  }

  // Connects a provider's identity from the profile, as its form submits.
  async function oidcConnect(
    id: OidcProviderId,
    token: string,
    who: MockIdentity,
  ) {
    const started = await app.inject({
      method: "POST",
      url: `/auth/oidc/${id}/connect`,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: REDIRECT_URLS[id].origin,
      },
      payload: "",
      cookies: { [SESSION_COOKIE]: token },
    });
    return throughProvider(id, started, who, { [SESSION_COOKIE]: token });
  }

  async function localAccount(address = email()) {
    const created = await createUser(tx, {
      email: address,
      password: PASSWORD,
    });
    if (!created) throw new Error("createUser returned null");
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: address, password: PASSWORD },
    });
    return { ...created, token: cookieValue(res, SESSION_COOKIE) };
  }

  async function me(token: string) {
    return (await request("GET", "/me", { [SESSION_COOKIE]: token })).json<{
      hasPassword: boolean;
      oidc: { providers: unknown[]; connected: boolean };
    }>();
  }

  return { app, request, oidcSignIn, oidcConnect, localAccount, me };
}

async function accountWithEmail(tx: TestTransaction, address: string) {
  const [account] = await tx
    .select({ id: user.id, passwordHash: user.passwordHash })
    .from(user)
    .where(eq(user.email, address));
  return account;
}

async function identitiesOf(tx: TestTransaction, userId: number) {
  return tx
    .select({ issuer: oidcIdentity.issuer, subject: oidcIdentity.subject })
    .from(oidcIdentity)
    .where(eq(oidcIdentity.userId, userId));
}

describe("GET /auth/oidc/config with Google", () => {
  dbTest.for([
    [true, true, ["generic", "google"]],
    [true, false, ["generic"]],
    [false, true, ["google"]],
    [false, false, []],
  ] as const)(
    "generic %s, google %s: lists %j",
    async ([genericOn, googleOn, ids], { tx }) => {
      const { request } = start(tx, {
        generic: genericOn ? provider("generic") : null,
        google: googleOn ? provider("google") : null,
      });

      const res = await request("GET", "/auth/oidc/config");

      const names = { generic: "Home SSO", google: "Google" };
      expect(res.json()).toEqual({
        enabled: ids.length > 0,
        providers: ids.map((id) => ({ id, displayName: names[id] })),
        displayName: genericOn ? "Home SSO" : null,
      });
    },
  );
});

describe("signing in with Google", () => {
  dbTest(
    "creates an account with no password, and the same identity signs in to it again",
    async ({ tx }) => {
      const { oidcSignIn, me } = start(tx);
      const who = identity();

      const first = await oidcSignIn("google", who);

      expect(first.headers.location).toBe("/");
      const account = await accountWithEmail(tx, who.email!);
      expect(account!.passwordHash).toBeNull();
      expect(await identitiesOf(tx, account!.id)).toEqual([
        { issuer: mocks.google.issuer.origin, subject: who.sub },
      ]);
      expect(await me(cookieValue(first, SESSION_COOKIE))).toMatchObject({
        hasPassword: false,
        oidc: {
          providers: [
            { id: "generic", displayName: "Home SSO", connected: false },
            { id: "google", displayName: "Google", connected: true },
          ],
          // The generic provider's, for the web app until it reads providers.
          connected: false,
        },
      });

      const again = await oidcSignIn("google", { ...who, email: email() });
      expect(again.headers.location).toBe("/");
      expect(await identitiesOf(tx, account!.id)).toHaveLength(1);
    },
  );

  dbTest(
    "links to the account with a verified email, and refuses an unverified one",
    async ({ tx }) => {
      const { oidcSignIn, localAccount } = start(tx);
      const local = await localAccount();

      const unverified = await oidcSignIn(
        "google",
        identity({ email: local.email, email_verified: false }),
      );
      expect(unverified.headers.location).toBe(
        "/sign-in?oidc_error=email_unverified",
      );
      expect(await identitiesOf(tx, local.id)).toEqual([]);

      const who = identity({ email: local.email.toUpperCase() });
      const verified = await oidcSignIn("google", who);
      expect(verified.headers.location).toBe("/");
      expect(await identitiesOf(tx, local.id)).toEqual([
        { issuer: mocks.google.issuer.origin, subject: who.sub },
      ]);
    },
  );

  dbTest("refuses a disabled account", async ({ tx }) => {
    const { oidcSignIn } = start(tx);
    const who = identity();
    await oidcSignIn("google", who);
    await tx
      .update(user)
      .set({ disabledAt: new Date() })
      .where(eq(user.email, who.email!));

    const res = await oidcSignIn("google", who);

    expect(res.headers.location).toBe("/sign-in?oidc_error=account_disabled");
    expect(res.cookies.some((c) => c.name === SESSION_COOKIE)).toBe(false);
  });

  dbTest(
    "keeps one identity per provider: a second Google identity for the same account is refused",
    async ({ tx }) => {
      const { oidcSignIn, localAccount } = start(tx);
      const local = await localAccount();
      await oidcSignIn("google", identity({ email: local.email }));

      const res = await oidcSignIn("google", identity({ email: local.email }));

      expect(res.headers.location).toBe(
        "/sign-in?oidc_error=already_connected",
      );
    },
  );

  dbTest(
    "scopes the trip cookie to Google's callback, so the generic callback cannot finish it",
    async ({ tx }) => {
      const { request } = start(tx);

      const started = await request("GET", "/auth/oidc/google/start");

      expect(new URL(started.headers.location as string).origin).toBe(
        mocks.google.issuer.origin,
      );
      expect(started.cookies.find((c) => c.name === OIDC_COOKIE)).toMatchObject(
        { path: "/api/auth/oidc/google/callback" },
      );
      const crossed = await request("GET", "/auth/oidc/callback?code=x", {
        [OIDC_COOKIE]: cookieValue(started, OIDC_COOKIE),
      });
      expect(crossed.headers.location).toBe(
        "/sign-in?oidc_error=provider_error",
      );
    },
  );
});

describe("connecting Google from the profile", () => {
  dbTest(
    "links an identity whose email matches, beside a generic one",
    async ({ tx }) => {
      const { oidcConnect, localAccount, me } = start(tx);
      const local = await localAccount();
      await oidcConnect(
        "generic",
        local.token,
        identity({ email: local.email }),
      );

      const res = await oidcConnect(
        "google",
        local.token,
        identity({ email: local.email.toUpperCase(), email_verified: false }),
      );

      expect(res.headers.location).toBe("/profile?oidc=connected");
      expect((await me(local.token)).oidc.providers).toEqual([
        { id: "generic", displayName: "Home SSO", connected: true },
        { id: "google", displayName: "Google", connected: true },
      ]);
    },
  );

  dbTest("refuses a start from an untrusted origin", async ({ tx }) => {
    const { app, localAccount } = start(tx);
    const local = await localAccount();

    const res = await app.inject({
      method: "POST",
      url: "/auth/oidc/google/connect",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.localhost:5173",
      },
      payload: "",
      cookies: { [SESSION_COOKIE]: local.token },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "untrusted_origin" });
  });

  dbTest("refuses an identity with another email", async ({ tx }) => {
    const { oidcConnect, localAccount } = start(tx);
    const local = await localAccount();

    const res = await oidcConnect("google", local.token, identity());

    expect(res.headers.location).toBe("/profile?oidc_error=email_mismatch");
    expect(await identitiesOf(tx, local.id)).toEqual([]);
  });
});

describe("DELETE /auth/oidc/:provider/connection", () => {
  const refused = {
    error: "no_other_sign_in",
    message: "an account cannot disconnect its only way to sign in",
  };

  dbTest(
    "disconnects Google from an account with a password, leaving the generic link",
    async ({ tx }) => {
      const { oidcConnect, localAccount, request } = start(tx);
      const local = await localAccount();
      const generic = identity({ email: local.email });
      await oidcConnect("generic", local.token, generic);
      await oidcConnect(
        "google",
        local.token,
        identity({ email: local.email }),
      );

      for (let i = 0; i < 2; i++) {
        const res = await request("DELETE", "/auth/oidc/google/connection", {
          [SESSION_COOKIE]: local.token,
        });
        expect(res.statusCode).toBe(204);
      }

      expect(await identitiesOf(tx, local.id)).toEqual([
        { issuer: mocks.generic.issuer.origin, subject: generic.sub },
      ]);
    },
  );

  dbTest(
    "lets an account with no password disconnect one of two identities, not the last",
    async ({ tx }) => {
      const { oidcSignIn, oidcConnect, request, me } = start(tx);
      const who = identity();
      const token = cookieValue(
        await oidcSignIn("google", who),
        SESSION_COOKIE,
      );
      await oidcConnect("generic", token, identity({ email: who.email! }));

      const first = await request("DELETE", "/auth/oidc/google/connection", {
        [SESSION_COOKIE]: token,
      });
      expect(first.statusCode).toBe(204);

      const last = await request("DELETE", "/auth/oidc/generic/connection", {
        [SESSION_COOKIE]: token,
      });
      expect(last.statusCode).toBe(409);
      expect(last.json()).toEqual(refused);
      expect((await me(token)).oidc.providers).toEqual([
        { id: "generic", displayName: "Home SSO", connected: true },
        { id: "google", displayName: "Google", connected: false },
      ]);
    },
  );

  dbTest(
    "refuses an account whose other identity's provider is not configured",
    async ({ tx }) => {
      const both = start(tx);
      const who = identity();
      const token = cookieValue(
        await both.oidcSignIn("google", who),
        SESSION_COOKIE,
      );
      await both.oidcConnect("generic", token, identity({ email: who.email! }));
      // The generic provider switched off: its link can sign in no one.
      const googleOnly = start(tx, { generic: null });

      const res = await googleOnly.request(
        "DELETE",
        "/auth/oidc/google/connection",
        { [SESSION_COOKIE]: token },
      );

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual(refused);
    },
  );
});

describe("the unprefixed routes", () => {
  dbTest("serve the generic provider", async ({ tx }) => {
    const { oidcSignIn, request, me } = start(tx);
    const who = identity();

    const res = await oidcSignIn("generic", who, "/auth/oidc/start");

    expect(res.headers.location).toBe("/");
    const token = cookieValue(res, SESSION_COOKIE);
    expect((await me(token)).oidc).toMatchObject({
      providers: [
        { id: "generic", connected: true },
        { id: "google", connected: false },
      ],
      connected: true,
    });
    const viaPrefix = await request("GET", "/auth/oidc/generic/start");
    expect(new URL(viaPrefix.headers.location as string).origin).toBe(
      mocks.generic.issuer.origin,
    );
  });

  dbTest(
    "answer 404 when only Google is configured, as the generic provider's",
    async ({ tx }) => {
      const { request, localAccount } = start(tx, { generic: null });
      const local = await localAccount();

      for (const [method, url] of [
        ["GET", "/auth/oidc/start"],
        ["GET", "/auth/oidc/callback?code=x&state=y"],
        ["POST", "/auth/oidc/connect"],
        ["DELETE", "/auth/oidc/connection"],
        ["GET", "/auth/oidc/generic/start"],
      ] as const) {
        const res = await request(method, url, {
          [SESSION_COOKIE]: local.token,
        });
        expect(res.statusCode).toBe(404);
      }
      expect((await request("GET", "/auth/oidc/google/start")).statusCode).toBe(
        302,
      );
    },
  );
});

describe("Google switched off", () => {
  dbTest(
    "answers 404 on every Google route and leaves the generic provider working",
    async ({ tx }) => {
      const { request, localAccount, oidcSignIn } = start(tx, {
        google: null,
      });
      const local = await localAccount();

      for (const [method, url] of [
        ["GET", "/auth/oidc/google/start"],
        ["GET", "/auth/oidc/google/callback?code=x&state=y"],
        ["POST", "/auth/oidc/google/connect"],
        ["DELETE", "/auth/oidc/google/connection"],
        ["GET", "/auth/oidc/apple/start"],
      ] as const) {
        const res = await request(method, url, {
          [SESSION_COOKIE]: local.token,
        });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({
          error: "not_found",
          message: "oidc sign-in is not configured",
        });
      }
      expect(
        (await oidcSignIn("generic", identity(), "/auth/oidc/start")).headers
          .location,
      ).toBe("/");
    },
  );
});

describe("admission limits with Google", () => {
  const rateLimited = {
    error: "rate_limited",
    message: "too many sign-in attempts; try again in a minute",
  };

  dbTest(
    "counts trips in progress across both providers against one bound",
    async ({ tx }) => {
      const { request } = start(tx, {
        generic: provider("generic", { maxPendingLogins: 1 }),
        google: provider("google", { maxPendingLogins: 1 }),
      });

      expect((await request("GET", "/auth/oidc/start")).statusCode).toBe(302);
      const res = await request("GET", "/auth/oidc/google/start");

      expect(res.statusCode).toBe(429);
      expect(res.json()).toEqual(rateLimited);
    },
  );

  dbTest(
    "limits Google's start, callback and disconnect per client",
    async ({ tx }) => {
      const limits = { startsPerMinute: 2 };
      const { request, localAccount } = start(tx, {
        generic: provider("generic", limits),
        google: provider("google", limits),
      });
      const local = await localAccount();

      for (const [method, url] of [
        ["GET", "/auth/oidc/google/start"],
        ["GET", "/auth/oidc/google/callback"],
        ["DELETE", "/auth/oidc/google/connection"],
      ] as const) {
        const answers = [];
        for (let i = 0; i < 3; i++) {
          const res = await request(method, url, {
            [SESSION_COOKIE]: local.token,
          });
          answers.push(res.statusCode);
        }
        expect(answers[2]).toBe(429);
      }
    },
  );
});
