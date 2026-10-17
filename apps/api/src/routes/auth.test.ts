import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import type { LightMyRequestResponse as Response } from "fastify";
import { describe, expect, it, onTestFinished } from "vitest";
import { buildApp } from "../app.js";
import { ensureAdmin } from "../auth/accounts.js";
import { loadConfig } from "../config.js";
import { user } from "../db/schema.js";
import { dbTest, type TestTransaction } from "../test/db.js";
import { SESSION_COOKIE } from "./auth.js";

// Different from the addresses other test files use, so their inserts never
// wait on each other's unique index entries.
const EMAIL = "cook@routes.test";
const PASSWORD = "correct horse";

const unused = () => Promise.reject(new Error("not used by these tests"));

// The app on the test transaction, with its log lines collected.
function start(
  tx: TestTransaction,
  secureCookies = true,
  trustProxy: string[] | false = false,
) {
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
      secureCookies,
      settingsKey: Buffer.alloc(32),
    },
    { logger: { level: "info", stream }, trustProxy },
  );
  onTestFinished(() => app.close());

  const post = (
    url: string,
    payload?: object,
    token?: string,
  ): Promise<Response> =>
    app.inject({
      method: "POST",
      url,
      ...(payload === undefined ? {} : { payload }),
      cookies: token ? { [SESSION_COOKIE]: token } : {},
    });
  const me = (token?: string): Promise<Response> =>
    app.inject({
      method: "GET",
      url: "/me",
      cookies: token ? { [SESSION_COOKIE]: token } : {},
    });
  const patchMe = (payload: unknown, token: string): Promise<Response> =>
    app.inject({
      method: "PATCH",
      url: "/me",
      payload: payload as object,
      cookies: { [SESSION_COOKIE]: token },
    });

  return { app, logLines, post, me, patchMe };
}

function sessionCookie(res: Response) {
  return res.cookies.find((c) => c.name === SESSION_COOKIE);
}

function tokenFrom(res: Response): string {
  const cookie = sessionCookie(res);
  if (!cookie) throw new Error(`no ${SESSION_COOKIE} cookie in response`);
  return cookie.value;
}

describe("POST /auth/register", () => {
  dbTest(
    "creates the account, signs it in, and returns the profile",
    async ({ tx }) => {
      const { post, me } = start(tx);

      const res = await post("/auth/register", {
        email: ` ${EMAIL} `,
        password: PASSWORD,
        displayName: " Sam ",
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        id: expect.any(Number) as number,
        email: EMAIL,
        displayName: "Sam",
        locale: "en-GB",
        isAdmin: false,
      });
      expect(sessionCookie(res)).toMatchObject({
        httpOnly: true,
        sameSite: "Lax",
        secure: true,
        path: "/",
      });
      expect((await me(tokenFrom(res))).json()).toEqual({
        ...res.json<object>(),
        hasPassword: true,
        oidc: { connected: false, connectedAt: null },
      });
    },
  );

  dbTest("leaves Secure off the cookie when configured to", async ({ tx }) => {
    const { post } = start(tx, false);

    const res = await post("/auth/register", {
      email: EMAIL,
      password: PASSWORD,
    });

    expect(sessionCookie(res)?.secure).toBeUndefined();
  });

  dbTest(
    "refuses an email already registered in another case",
    async ({ tx }) => {
      const { post } = start(tx);
      await post("/auth/register", { email: EMAIL, password: PASSWORD });

      const res = await post("/auth/register", {
        email: EMAIL.toUpperCase(),
        password: "another password",
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: "email_taken",
        message: "an account with this email already exists",
      });
      expect(sessionCookie(res)).toBeUndefined();
    },
  );

  dbTest.for<[string, object | undefined, string]>([
    ["no body", undefined, "email and password must be strings"],
    [
      "a bad email",
      { email: "cook", password: PASSWORD },
      "email is not valid",
    ],
    [
      "a short password",
      { email: EMAIL, password: "short" },
      "password must be at least 8 characters",
    ],
    [
      "a blank display name",
      { email: EMAIL, password: PASSWORD, displayName: "  " },
      "displayName must not be blank",
    ],
  ])(
    "returns 400 invalid_request for %s",
    async ([, payload, message], { tx }) => {
      const { post } = start(tx);

      const res = await post("/auth/register", payload);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_request", message });
    },
  );

  dbTest(
    "returns 400 invalid_request for a body that is not JSON",
    async ({ tx }) => {
      const { app } = start(tx);

      const res = await app.inject({
        method: "POST",
        url: "/auth/register",
        headers: { "content-type": "application/json" },
        payload: "{bad json",
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: "invalid_request",
        message: "body must be JSON",
      });
    },
  );
});

describe("POST /auth/login", () => {
  dbTest("signs in with the email in any case", async ({ tx }) => {
    const { post, me } = start(tx);
    await post("/auth/register", { email: EMAIL, password: PASSWORD });

    const res = await post("/auth/login", {
      email: "Cook@Routes.Test",
      password: PASSWORD,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: EMAIL });
    expect((await me(tokenFrom(res))).statusCode).toBe(200);
  });

  // JavaScript lowercases İ (U+0130) to i + U+0307, Postgres to plain i.
  dbTest(
    "signs in with an email Postgres and JavaScript lowercase differently",
    async ({ tx }) => {
      const { post } = start(tx);
      const email = "İzmir@example.com";
      expect(
        (await post("/auth/register", { email, password: PASSWORD }))
          .statusCode,
      ).toBe(201);

      const res = await post("/auth/login", { email, password: PASSWORD });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ email });
    },
  );

  dbTest(
    "answers a wrong password and an unknown email identically",
    async ({ tx }) => {
      const { post, logLines } = start(tx);
      await post("/auth/register", { email: EMAIL, password: PASSWORD });

      const wrong = await post("/auth/login", {
        email: EMAIL,
        password: "wrong password",
      });
      const unknown = await post("/auth/login", {
        email: "nobody@routes.test",
        password: "wrong password",
      });

      for (const res of [wrong, unknown]) {
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({
          error: "invalid_credentials",
          message: "email or password is incorrect",
        });
        expect(sessionCookie(res)).toBeUndefined();
      }
      expect(wrong.body).toBe(unknown.body);
      expect(wrong.headers["content-type"]).toBe(
        unknown.headers["content-type"],
      );

      const failures = logLines.filter((l) => l.msg === "auth: sign-in failed");
      expect(failures).toEqual([
        expect.objectContaining({ level: 40, email: EMAIL, ip: "127.0.0.1" }),
        expect.objectContaining({
          level: 40,
          email: "nobody@routes.test",
          ip: "127.0.0.1",
        }),
      ]);
      expect(JSON.stringify(logLines)).not.toContain("wrong password");
    },
  );

  dbTest(
    "refuses a disabled account and its existing sessions",
    async ({ tx }) => {
      const { post, me } = start(tx);
      const registered = await post("/auth/register", {
        email: EMAIL,
        password: PASSWORD,
      });
      const token = tokenFrom(registered);

      await tx
        .update(user)
        .set({ disabledAt: new Date() })
        .where(eq(user.email, EMAIL));

      const login = await post("/auth/login", {
        email: EMAIL,
        password: PASSWORD,
      });
      expect(login.statusCode).toBe(401);
      expect(login.json()).toMatchObject({ error: "invalid_credentials" });
      expect((await me(token)).statusCode).toBe(401);
    },
  );
});

describe("POST /auth/login with an over-length password", () => {
  dbTest(
    "answers 400 and writes the failed sign-in line with only email and ip",
    async ({ tx }) => {
      const { post, logLines } = start(tx);
      const password = "p".repeat(1025);

      const res = await post("/auth/login", { email: ` ${EMAIL} `, password });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: "invalid_request",
        message: "password must be at most 1024 characters",
      });
      const failures = logLines.filter((l) => l.msg === "auth: sign-in failed");
      expect(failures).toHaveLength(1);
      // pino's own fields, plus the two the decision allows.
      const { level, time, pid, hostname, reqId, msg, ...rest } = failures[0]!;
      expect({ level, msg }).toEqual({
        level: 40,
        msg: "auth: sign-in failed",
      });
      expect([time, pid, hostname, reqId]).not.toContain(undefined);
      expect(rest).toEqual({ email: EMAIL, ip: "127.0.0.1" });
      expect(JSON.stringify(logLines)).not.toContain(password);
    },
  );
});

// What server.ts passes to Fastify for a given TRUST_PROXY.
function trustProxyFrom(raw: string | undefined) {
  return loadConfig({
    DATABASE_URL: "postgres://unused",
    SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32).toString("hex"),
    TRUST_PROXY: raw,
  }).trustProxy;
}

describe("the failed sign-in line behind a proxy", () => {
  // The injected request's socket address.
  const PEER = "127.0.0.1";

  async function failedSignInIp(
    tx: TestTransaction,
    trustProxy: string | undefined,
    forwardedFor: string,
  ) {
    const { app, logLines } = start(tx, true, trustProxyFrom(trustProxy));
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: EMAIL, password: "wrong password" },
      headers: { "x-forwarded-for": forwardedFor },
    });
    expect(res.statusCode).toBe(401);
    const failures = logLines.filter((l) => l.msg === "auth: sign-in failed");
    expect(failures).toHaveLength(1);
    return failures[0]!.ip;
  }

  dbTest("logs the client address the trusted proxy sent", async ({ tx }) => {
    expect(await failedSignInIp(tx, PEER, "203.0.113.9")).toBe("203.0.113.9");
  });

  dbTest(
    "ignores what the client put in front of the proxy's entry",
    async ({ tx }) => {
      expect(await failedSignInIp(tx, PEER, "198.51.100.7, 203.0.113.9")).toBe(
        "203.0.113.9",
      );
    },
  );

  dbTest(
    "logs the socket address when the peer is not a listed proxy",
    async ({ tx }) => {
      expect(await failedSignInIp(tx, "10.0.0.0/8", "203.0.113.9")).toBe(PEER);
    },
  );

  dbTest(
    "logs the socket address when TRUST_PROXY is unset",
    async ({ tx }) => {
      expect(await failedSignInIp(tx, undefined, "203.0.113.9")).toBe(PEER);
    },
  );
});

describe("admin bootstrap of a self-registered account", () => {
  const ADMIN_PASSWORD = "the operator's one";

  dbTest(
    "takes the account over: old password and cookie refused, ADMIN_PASSWORD works",
    async ({ tx }) => {
      const { post, me } = start(tx);
      const token = tokenFrom(
        await post("/auth/register", { email: EMAIL, password: PASSWORD }),
      );

      expect(
        await ensureAdmin(tx, { email: EMAIL, password: ADMIN_PASSWORD }),
      ).toBe("promoted");

      expect((await me(token)).statusCode).toBe(401);
      expect(
        (await post("/auth/login", { email: EMAIL, password: PASSWORD }))
          .statusCode,
      ).toBe(401);
      const login = await post("/auth/login", {
        email: EMAIL,
        password: ADMIN_PASSWORD,
      });
      expect(login.statusCode).toBe(200);
      expect(login.json()).toMatchObject({ isAdmin: true });
    },
  );

  dbTest(
    "changes nothing on a second start with a different ADMIN_PASSWORD",
    async ({ tx }) => {
      const { post, me } = start(tx);
      await post("/auth/register", { email: EMAIL, password: PASSWORD });
      await ensureAdmin(tx, { email: EMAIL, password: ADMIN_PASSWORD });
      const token = tokenFrom(
        await post("/auth/login", { email: EMAIL, password: ADMIN_PASSWORD }),
      );

      expect(
        await ensureAdmin(tx, { email: EMAIL, password: "a different one" }),
      ).toBe("unchanged");

      expect((await me(token)).statusCode).toBe(200);
      expect(
        (await post("/auth/login", { email: EMAIL, password: ADMIN_PASSWORD }))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await post("/auth/login", {
            email: EMAIL,
            password: "a different one",
          })
        ).statusCode,
      ).toBe(401);
    },
  );
});

describe("signed-in routes", () => {
  dbTest("answer 401 without a session cookie", async ({ tx }) => {
    const { me } = start(tx);

    const res = await me();

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: "unauthenticated",
      message: "sign in required",
    });
  });

  dbTest(
    "answer 401 and clear the cookie for an unknown session",
    async ({ tx }) => {
      const { me } = start(tx);

      const res = await me("not-a-session");

      expect(res.statusCode).toBe(401);
      expect(sessionCookie(res)).toMatchObject({ value: "" });
    },
  );

  dbTest("leave health and the auth routes open", async ({ tx }) => {
    const { app, post } = start(tx);

    expect(
      (await app.inject({ method: "GET", url: "/health" })).statusCode,
    ).toBe(200);
    expect((await post("/auth/logout")).statusCode).toBe(204);
  });
});

describe("auth routes when a request fails", () => {
  dbTest(
    "answer a body over the size limit with 413, logged below error",
    async ({ tx }) => {
      const { app, logLines } = start(tx);

      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          email: "a@b.c",
          password: "x".repeat(2_000_000),
        }),
      });

      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({
        error: "invalid_request",
        message: "body is too large",
      });
      expect(logLines.filter((l) => (l.level as number) >= 50)).toEqual([]);
      expect(logLines).toContainEqual(
        expect.objectContaining({
          level: 40,
          msg: "auth: request refused",
          route: "POST /auth/login",
          status: 413,
          code: "FST_ERR_CTP_BODY_TOO_LARGE",
        }),
      );
    },
  );

  it("still answer an unexpected failure with 500, logged at error", async () => {
    // A database every query on which throws, as Drizzle does, with the
    // query's parameters after the first line of the message.
    const broken = new Proxy(
      {},
      {
        get() {
          throw new Error("Failed query: select\nparams: a@b.c");
        },
      },
    ) as unknown as TestTransaction;
    const { post, logLines } = start(broken);

    const res = await post("/auth/login", { email: "a@b.c", password: "x" });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: "internal_error",
      message: "something went wrong",
    });
    expect(logLines).toContainEqual(
      expect.objectContaining({
        level: 50,
        msg: "auth: request failed",
        route: "POST /auth/login",
        error: "Failed query: select",
      }),
    );
    expect(JSON.stringify(logLines)).not.toContain("params: a@b.c");
  });
});

describe("POST /auth/logout", () => {
  dbTest("ends the session, and repeating it is harmless", async ({ tx }) => {
    const { post, me } = start(tx);
    const token = tokenFrom(
      await post("/auth/register", { email: EMAIL, password: PASSWORD }),
    );

    const res = await post("/auth/logout", undefined, token);

    expect(res.statusCode).toBe(204);
    expect(sessionCookie(res)).toMatchObject({ value: "" });
    expect((await me(token)).statusCode).toBe(401);
    expect((await post("/auth/logout", undefined, token)).statusCode).toBe(204);
  });

  dbTest("leaves the user's other sessions alone", async ({ tx }) => {
    const { post, me } = start(tx);
    const first = tokenFrom(
      await post("/auth/register", { email: EMAIL, password: PASSWORD }),
    );
    const second = tokenFrom(
      await post("/auth/login", { email: EMAIL, password: PASSWORD }),
    );

    await post("/auth/logout", undefined, first);

    expect((await me(second)).statusCode).toBe(200);
  });
});

describe("PATCH /me", () => {
  dbTest("changes display name and locale", async ({ tx }) => {
    const { post, me, patchMe } = start(tx);
    const token = tokenFrom(
      await post("/auth/register", { email: EMAIL, password: PASSWORD }),
    );

    const res = await patchMe({ displayName: " Sam ", locale: "en-au" }, token);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: expect.any(Number) as number,
      email: EMAIL,
      displayName: "Sam",
      locale: "en-AU",
      isAdmin: false,
      hasPassword: true,
      oidc: { connected: false, connectedAt: null },
    });
    expect((await me(token)).json()).toEqual(res.json());
  });

  dbTest(
    "clears the display name with null and leaves locale alone",
    async ({ tx }) => {
      const { post, patchMe } = start(tx);
      const token = tokenFrom(
        await post("/auth/register", {
          email: EMAIL,
          password: PASSWORD,
          displayName: "Sam",
        }),
      );

      const res = await patchMe({ displayName: null }, token);

      expect(res.json()).toMatchObject({ displayName: null, locale: "en-GB" });
    },
  );

  dbTest.for<[string, unknown, string]>([
    ["an empty body", {}, "send displayName or locale"],
    ["an unknown field", { email: "x@y.z" }, "unknown field: email"],
    [
      "a malformed locale",
      { locale: "not a tag" },
      "locale must be a BCP-47 language tag",
    ],
    [
      "a non-string locale",
      { locale: 5 },
      "locale must be a BCP-47 language tag",
    ],
    [
      "a too-long display name",
      { displayName: "x".repeat(101) },
      "displayName must be at most 100 characters",
    ],
  ])(
    "returns 400 invalid_request for %s",
    async ([, payload, message], { tx }) => {
      const { post, patchMe } = start(tx);
      const token = tokenFrom(
        await post("/auth/register", { email: EMAIL, password: PASSWORD }),
      );

      const res = await patchMe(payload, token);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_request", message });
    },
  );

  dbTest("answers 401 without a session cookie", async ({ tx }) => {
    const { app } = start(tx);

    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      payload: { locale: "en-AU" },
    });

    expect(res.statusCode).toBe(401);
  });
});
