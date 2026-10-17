import { randomBytes } from "node:crypto";
import { connect, type AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import type { LightMyRequestResponse as Response } from "fastify";
import { describe, expect, onTestFinished } from "vitest";
import { buildApp, logRedactPaths, logSerializers } from "../app.js";
import { providerCredential } from "../ai/settings.js";
import { createUser } from "../auth/accounts.js";
import { session, user } from "../db/schema.js";
import { dbTest, type TestTransaction } from "../test/db.js";
import { SESSION_COOKIE } from "./auth.js";

const PASSWORD = "correct horse";
const settingsKey = randomBytes(32);
const unused = () => Promise.reject(new Error("not used by these tests"));

type Method = "GET" | "POST" | "PUT" | "DELETE";

// The app on the test transaction, logging everything at trace level with
// the server's redaction, with its log lines collected.
function start(tx: TestTransaction) {
  const logLines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logLines.push(chunk.toString());
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
      settingsKey,
    },
    {
      logger: {
        level: "trace",
        stream,
        redact: logRedactPaths,
        serializers: logSerializers,
      },
    },
  );
  onTestFinished(() => app.close());

  const request = (
    method: Method,
    url: string,
    token: string | undefined,
    payload?: object,
  ): Promise<Response> =>
    app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
      cookies: token ? { [SESSION_COOKIE]: token } : {},
    });

  // Makes an account and signs it in through POST /auth/login.
  async function signedIn({ admin = false } = {}): Promise<{
    id: number;
    email: string;
    token: string;
  }> {
    const email = `${admin ? "admin" : "cook"}-${crypto.randomUUID()}@admin-routes.test`;
    const created = await createUser(tx, { email, password: PASSWORD });
    if (!created) throw new Error("createUser returned null");
    if (admin) {
      await tx
        .update(user)
        .set({ isAdmin: true })
        .where(eq(user.id, created.id));
    }
    const token = await login(email);
    if (!token) throw new Error("sign-in failed");
    return { id: created.id, email, token };
  }

  // The session token, or null if the sign-in was refused.
  async function login(email: string, password = PASSWORD) {
    const res = await request("POST", "/auth/login", undefined, {
      email,
      password,
    });
    if (res.statusCode !== 200) return null;
    return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  }

  return { app, logLines, request, signedIn, login };
}

// The req of each "incoming request" log line, in order.
function incomingRequests(logLines: string[]) {
  return logLines
    .map((line) => JSON.parse(line) as { msg: string; req?: object })
    .filter((line) => line.msg === "incoming request")
    .map((line) => line.req);
}

// Every admin route, with a body each would accept from an admin.
const adminRoutes: [Method, string, object?][] = [
  ["GET", "/admin/users"],
  ["POST", "/admin/users/1/disable"],
  ["POST", "/admin/users/1/enable"],
  ["POST", "/admin/users/1/grant-admin"],
  ["POST", "/admin/users/1/revoke-admin"],
  ["PUT", "/admin/users/1/password", { password: "a new password" }],
  ["DELETE", "/admin/users/1"],
  ["GET", "/admin/ai"],
  ["PUT", "/admin/ai/providers/anthropic", { apiKey: "sk-ant-forbidden" }],
  ["PUT", "/admin/ai/providers/ollama", { baseUrl: "http://ollama:11434" }],
  ["DELETE", "/admin/ai/providers/openai"],
  ["PUT", "/admin/ai/models/default", { provider: "openai", model: "gpt-5" }],
];

describe("admin routes", () => {
  dbTest.for(adminRoutes)(
    "%s %s answers 403 to a signed-in non-admin and changes nothing",
    async ([method, url, payload], { tx }) => {
      const { request, signedIn } = start(tx);
      const cook = await signedIn();
      const before = await tx.select().from(user);

      const res = await request(method, url, cook.token, payload);

      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "forbidden", message: "admin only" });
      expect(await tx.select().from(user)).toEqual(before);
      expect(await providerCredential(tx, settingsKey, "anthropic")).toBeNull();
    },
  );

  dbTest.for(adminRoutes)(
    "%s %s answers 401 without a session",
    async ([method, url, payload], { tx }) => {
      const { request } = start(tx);

      const res = await request(method, url, undefined, payload);

      expect(res.statusCode).toBe(401);
    },
  );

  dbTest("refuse an admin whose role was just revoked", async ({ tx }) => {
    const { request, signedIn } = start(tx);
    const admin = await signedIn({ admin: true });
    const other = await signedIn({ admin: true });

    expect(
      (
        await request(
          "POST",
          `/admin/users/${other.id}/revoke-admin`,
          admin.token,
        )
      ).statusCode,
    ).toBe(200);

    expect((await request("GET", "/admin/users", other.token)).statusCode).toBe(
      403,
    );
  });
});

describe("GET /admin/users", () => {
  dbTest("lists every account without password hashes", async ({ tx }) => {
    const { request, signedIn } = start(tx);
    const admin = await signedIn({ admin: true });
    const cook = await signedIn();

    const res = await request("GET", "/admin/users", admin.token);

    expect(res.statusCode).toBe(200);
    const { users } = res.json<{ users: Record<string, unknown>[] }>();
    expect(users.find((u) => u.id === cook.id)).toEqual({
      id: cook.id,
      email: cook.email,
      displayName: null,
      locale: "en-GB",
      isAdmin: false,
      disabledAt: null,
      hasPassword: true,
      createdAt: expect.any(String) as string,
    });
    expect(users.find((u) => u.id === admin.id)).toMatchObject({
      isAdmin: true,
    });
    expect(res.body).not.toContain("argon2");
  });
});

describe("disable and enable", () => {
  dbTest(
    "disabling ends the user's sessions at once and stops sign-in",
    async ({ tx }) => {
      const { request, signedIn, login } = start(tx);
      const admin = await signedIn({ admin: true });
      const cook = await signedIn();
      const secondToken = await login(cook.email);

      const res = await request(
        "POST",
        `/admin/users/${cook.id}/disable`,
        admin.token,
      );

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: cook.id,
        disabledAt: expect.any(String) as string,
      });
      expect((await request("GET", "/me", cook.token)).statusCode).toBe(401);
      expect((await request("GET", "/me", secondToken!)).statusCode).toBe(401);
      expect(
        await tx.select().from(session).where(eq(session.userId, cook.id)),
      ).toEqual([]);
      expect(await login(cook.email)).toBeNull();
    },
  );

  dbTest(
    "disabling twice keeps the first time, and enabling restores sign-in",
    async ({ tx }) => {
      const { request, signedIn, login } = start(tx);
      const admin = await signedIn({ admin: true });
      const cook = await signedIn();
      const url = `/admin/users/${cook.id}`;

      const first = await request("POST", `${url}/disable`, admin.token);
      const second = await request("POST", `${url}/disable`, admin.token);
      expect(second.statusCode).toBe(200);
      expect(second.json<{ disabledAt: string }>().disabledAt).toBe(
        first.json<{ disabledAt: string }>().disabledAt,
      );

      const enabled = await request("POST", `${url}/enable`, admin.token);
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json()).toMatchObject({ disabledAt: null });
      expect(
        (await request("POST", `${url}/enable`, admin.token)).statusCode,
      ).toBe(200);
      expect(await login(cook.email)).not.toBeNull();
    },
  );
});

describe("self-protection", () => {
  dbTest.for([
    ["POST", "disable", "/disable"],
    ["POST", "revoke admin", "/revoke-admin"],
    ["DELETE", "delete", ""],
  ] as const)(
    "%s: an admin cannot %s their own account",
    async ([method, action, suffix], { tx }) => {
      const { request, signedIn } = start(tx);
      const admin = await signedIn({ admin: true });

      const res = await request(
        method,
        `/admin/users/${admin.id}${suffix}`,
        admin.token,
      );

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: "cannot_change_own_account",
        message: `an admin cannot ${action} their own account`,
      });
      const me = await request("GET", "/me", admin.token);
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ isAdmin: true });
    },
  );

  dbTest("an admin can disable another admin", async ({ tx }) => {
    const { request, signedIn } = start(tx);
    const admin = await signedIn({ admin: true });
    const other = await signedIn({ admin: true });

    expect(
      (await request("POST", `/admin/users/${other.id}/disable`, admin.token))
        .statusCode,
    ).toBe(200);
    expect((await request("GET", "/admin/users", other.token)).statusCode).toBe(
      401,
    );
  });
});

describe("grant and revoke admin", () => {
  dbTest(
    "grants the role, which works at once, then revokes it",
    async ({ tx }) => {
      const { request, signedIn } = start(tx);
      const admin = await signedIn({ admin: true });
      const cook = await signedIn();
      const url = `/admin/users/${cook.id}`;

      const granted = await request("POST", `${url}/grant-admin`, admin.token);
      expect(granted.statusCode).toBe(200);
      expect(granted.json()).toMatchObject({ id: cook.id, isAdmin: true });
      expect(
        (await request("GET", "/admin/users", cook.token)).statusCode,
      ).toBe(200);

      const revoked = await request("POST", `${url}/revoke-admin`, admin.token);
      expect(revoked.json()).toMatchObject({ isAdmin: false });
      expect(
        (await request("POST", `${url}/revoke-admin`, admin.token)).statusCode,
      ).toBe(200);
      expect(
        (await request("GET", "/admin/users", cook.token)).statusCode,
      ).toBe(403);
    },
  );
});

describe("PUT /admin/users/:id/password", () => {
  dbTest("sets a password that works as-is", async ({ tx }) => {
    const { request, signedIn, login } = start(tx);
    const admin = await signedIn({ admin: true });
    const cook = await signedIn();

    const res = await request(
      "PUT",
      `/admin/users/${cook.id}/password`,
      admin.token,
      { password: "set by the admin" },
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: cook.id, hasPassword: true });
    expect(res.body).not.toContain("set by the admin");
    expect(await login(cook.email, "set by the admin")).not.toBeNull();
    expect(await login(cook.email)).toBeNull();
  });

  dbTest.for([{}, { password: 12345678 }, { password: "short" }])(
    "answers 400 to %j",
    async (payload, { tx }) => {
      const { request, signedIn } = start(tx);
      const admin = await signedIn({ admin: true });
      const cook = await signedIn();

      const res = await request(
        "PUT",
        `/admin/users/${cook.id}/password`,
        admin.token,
        payload,
      );

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid_request" });
    },
  );
});

describe("DELETE /admin/users/:id", () => {
  dbTest("deletes the account and its sessions, then 404s", async ({ tx }) => {
    const { request, signedIn } = start(tx);
    const admin = await signedIn({ admin: true });
    const cook = await signedIn();

    const res = await request("DELETE", `/admin/users/${cook.id}`, admin.token);

    expect(res.statusCode).toBe(204);
    expect(await tx.select().from(user).where(eq(user.id, cook.id))).toEqual(
      [],
    );
    expect((await request("GET", "/me", cook.token)).statusCode).toBe(401);
    expect(
      (await request("DELETE", `/admin/users/${cook.id}`, admin.token))
        .statusCode,
    ).toBe(404);
  });
});

describe("unknown users", () => {
  dbTest.for(["abc", "0", "1.5", "99999999999999999999", "999999999"])(
    "answer 404 for the id %s",
    async (id, { tx }) => {
      const { request, signedIn } = start(tx);
      const admin = await signedIn({ admin: true });

      for (const [method, url, payload] of [
        ["POST", `/admin/users/${id}/disable`],
        ["POST", `/admin/users/${id}/grant-admin`],
        ["PUT", `/admin/users/${id}/password`, { password: "long enough" }],
        ["DELETE", `/admin/users/${id}`],
      ] as [Method, string, object?][]) {
        const res = await request(method, url, admin.token, payload);
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({
          error: "not_found",
          message: "user not found",
        });
      }
    },
  );
});

describe("AI provider settings", () => {
  const API_KEY = "sk-ant-api03-route-test-SECRET-value";

  dbTest(
    "sets a key, reports only that it is configured, and clears it",
    async ({ tx }) => {
      const { request, signedIn } = start(tx);
      const admin = await signedIn({ admin: true });

      const put = await request(
        "PUT",
        "/admin/ai/providers/anthropic",
        admin.token,
        { apiKey: ` ${API_KEY} ` },
      );
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ provider: "anthropic", configured: true });
      expect(put.body).not.toContain(API_KEY);
      // Saving the same key again is harmless.
      expect(
        (
          await request("PUT", "/admin/ai/providers/anthropic", admin.token, {
            apiKey: API_KEY,
          })
        ).statusCode,
      ).toBe(200);

      const get = await request("GET", "/admin/ai", admin.token);
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({
        providers: [
          { provider: "anthropic", configured: true },
          { provider: "openai", configured: false },
          { provider: "openrouter", configured: false },
          { provider: "ollama", configured: false },
        ],
        models: [{ procedure: "default", provider: null, model: null }],
      });
      expect(get.body).not.toContain(API_KEY);
      // Round trip: what the import will read is the key, trimmed.
      expect(await providerCredential(tx, settingsKey, "anthropic")).toBe(
        API_KEY,
      );

      for (let i = 0; i < 2; i++) {
        const del = await request(
          "DELETE",
          "/admin/ai/providers/anthropic",
          admin.token,
        );
        expect(del.statusCode).toBe(204);
      }
      expect(
        (await request("GET", "/admin/ai", admin.token)).json(),
      ).toMatchObject({
        providers: [{ provider: "anthropic", configured: false }, {}, {}, {}],
      });
      expect(await providerCredential(tx, settingsKey, "anthropic")).toBeNull();
    },
  );

  dbTest("sets the Ollama base URL", async ({ tx }) => {
    const { request, signedIn } = start(tx);
    const admin = await signedIn({ admin: true });
    const baseUrl = "http://user:pw@ollama.lan:11434";

    const res = await request(
      "PUT",
      "/admin/ai/providers/ollama",
      admin.token,
      {
        baseUrl,
      },
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: "ollama", configured: true });
    expect((await request("GET", "/admin/ai", admin.token)).body).not.toContain(
      "ollama.lan",
    );
    expect(await providerCredential(tx, settingsKey, "ollama")).toBe(baseUrl);
  });

  dbTest.for([
    ["anthropic", {}],
    ["anthropic", { apiKey: "" }],
    ["anthropic", { apiKey: "sk-ant two words" }],
    ["anthropic", { apiKey: 12345 }],
    ["anthropic", { apiKey: "x".repeat(1025) }],
    ["openai", { baseUrl: "http://ollama:11434" }],
    ["openai", { apiKey: "sk-ok", extra: "sk-ok" }],
    ["ollama", { apiKey: "sk-not-for-ollama" }],
    ["ollama", { baseUrl: "ollama:11434" }],
    ["ollama", { baseUrl: "ftp://ollama:11434" }],
  ] as const)(
    "PUT %s answers 400 to %j without storing or echoing it",
    async ([provider, payload], { tx }) => {
      const { request, signedIn, logLines } = start(tx);
      const admin = await signedIn({ admin: true });

      const res = await request(
        "PUT",
        `/admin/ai/providers/${provider}`,
        admin.token,
        payload,
      );

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid_request" });
      for (const value of Object.values(payload)) {
        if (typeof value === "string" && value !== "") {
          expect(res.body).not.toContain(value);
          expect(logLines.join("")).not.toContain(value);
        }
      }
      expect(await providerCredential(tx, settingsKey, provider)).toBeNull();
    },
  );

  dbTest.for([
    ["PUT", { apiKey: "sk-x" }],
    ["DELETE", undefined],
  ] as const)(
    "%s answers 404 for an unknown provider",
    async ([method, payload], { tx }) => {
      const { request, signedIn } = start(tx);
      const admin = await signedIn({ admin: true });

      const res = await request(
        method,
        "/admin/ai/providers/gemini",
        admin.token,
        payload,
      );

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: "not_found",
        message: "unknown provider",
      });
    },
  );

  dbTest(
    "never writes a saved key to the log, even at trace level",
    async ({ tx }) => {
      const { request, signedIn, logLines } = start(tx);
      const admin = await signedIn({ admin: true });
      const key = `sk-proj-${randomBytes(24).toString("hex")}`;

      await request("PUT", "/admin/ai/providers/openai", admin.token, {
        apiKey: key,
      });
      await request("GET", "/admin/ai", admin.token);

      const log = logLines.join("");
      expect(log).toContain("admin ai: provider changed");
      expect(log).not.toContain(key);
    },
  );

  dbTest(
    "never logs a key sent in the query string of a request that saves it",
    async ({ tx }) => {
      const { request, signedIn, logLines } = start(tx);
      const admin = await signedIn({ admin: true });
      const key = `sk-proj-${randomBytes(24).toString("hex")}`;

      const res = await request(
        "PUT",
        `/admin/ai/providers/openai?apiKey=${key}`,
        admin.token,
        { apiKey: key },
      );

      expect(res.statusCode).toBe(200);
      expect(incomingRequests(logLines)).toEqual([
        expect.objectContaining({ url: "/auth/login" }),
        expect.objectContaining({ url: "/admin/ai/providers/openai" }),
      ]);
      expect(logLines.join("")).not.toContain(key);
    },
  );

  dbTest.for(adminRoutes)(
    "%s %s logs its path without the query string",
    async ([method, url, payload], { tx }) => {
      const { request, logLines } = start(tx);
      const key = `sk-ant-${randomBytes(24).toString("hex")}`;

      await request(method, `${url}?apiKey=${key}&x=1`, undefined, payload);

      expect(incomingRequests(logLines)).toEqual([
        expect.objectContaining({ method, url }),
      ]);
      expect(logLines.join("")).not.toContain(key);
    },
  );

  // Spellings Fastify routes to an admin route or answers 404 for. The key
  // must not reach the log or the response from either.
  dbTest.for([
    ["/%61dmin/ai", 401],
    ["/admin/missing", 404],
    ["/admin", 404],
    ["//admin/ai", 404],
    ["/ADMIN/ai", 404],
    ["/admin%2Fai", 404],
    ["/administrators", 404],
    ["/health", 200],
  ] as const)(
    "logs %s without the query string, and the key nowhere",
    async ([path, status], { tx }) => {
      const { app, logLines } = start(tx);
      const key = `sk-ant-${randomBytes(24).toString("hex")}`;

      const res = await app.inject({ url: `${path}?apiKey=${key}&x=1` });

      expect(res.statusCode).toBe(status);
      expect(res.body).not.toContain(key);
      expect(incomingRequests(logLines)).toEqual([
        {
          method: "GET",
          url: path,
          host: "localhost:80",
          remoteAddress: "127.0.0.1",
        },
      ]);
      expect(logLines.join("")).not.toContain(key);
    },
  );

  dbTest(
    "answers an unknown route without repeating its URL",
    async ({ tx }) => {
      const { app } = start(tx);

      const res = await app.inject({ url: "/admin/missing?apiKey=sk-x" });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: "not_found",
        message: "route not found",
      });
    },
  );

  // app.inject drops a fragment before Fastify sees it, so this one is sent
  // over a socket, as a hand-rolled client could.
  dbTest("never logs a key sent in a fragment on the wire", async ({ tx }) => {
    const { app, logLines } = start(tx);
    const key = `sk-ant-${randomBytes(24).toString("hex")}`;
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;

    const response = await new Promise<string>((resolve, reject) => {
      let received = "";
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `GET /admin/missing#apiKey=${key} HTTP/1.1\r\n` +
            "Host: localhost\r\nConnection: close\r\n\r\n",
        );
      });
      socket.on("data", (chunk) => (received += chunk.toString()));
      socket.on("end", () => resolve(received));
      socket.on("error", reject);
    });

    expect(response).toMatch(/^HTTP\/1\.1 404 /);
    expect(response).not.toContain(key);
    expect(incomingRequests(logLines)).toEqual([
      expect.objectContaining({ url: "/admin/missing" }),
    ]);
    expect(logLines.join("")).not.toContain(key);
  });

  dbTest("redacts a credential if one is ever logged", ({ tx }) => {
    const { app, logLines } = start(tx);

    app.log.info({ body: { apiKey: "sk-logged-by-mistake" } }, "oops");
    app.log.info({ apiKey: "sk-logged-by-mistake" }, "oops");
    app.log.info({ settings: { baseUrl: "http://u:p@h" } }, "oops");

    expect(logLines).toHaveLength(3);
    expect(logLines.join("")).not.toContain("sk-logged-by-mistake");
    expect(logLines.join("")).not.toContain("u:p@h");
  });
});

describe("PUT /admin/ai/models/:procedure", () => {
  dbTest("sets and replaces the default model", async ({ tx }) => {
    const { request, signedIn } = start(tx);
    const admin = await signedIn({ admin: true });
    const url = "/admin/ai/models/default";

    const first = await request("PUT", url, admin.token, {
      provider: "openai",
      model: "gpt-5-mini",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      procedure: "default",
      provider: "openai",
      model: "gpt-5-mini",
    });
    await request("PUT", url, admin.token, {
      provider: "openrouter",
      model: " anthropic/claude-haiku-5.5 ",
    });

    expect(
      (await request("GET", "/admin/ai", admin.token)).json(),
    ).toMatchObject({
      models: [
        {
          procedure: "default",
          provider: "openrouter",
          model: "anthropic/claude-haiku-5.5",
        },
      ],
    });
  });

  dbTest("answers 404 for an unknown procedure", async ({ tx }) => {
    const { request, signedIn } = start(tx);
    const admin = await signedIn({ admin: true });

    const res = await request(
      "PUT",
      "/admin/ai/models/meal_plan",
      admin.token,
      {
        provider: "openai",
        model: "gpt-5",
      },
    );

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: "not_found",
      message: "unknown procedure",
    });
  });

  dbTest.for([
    {},
    { provider: "gemini", model: "gemini-pro" },
    { provider: "openai" },
    { provider: "openai", model: " " },
    { provider: "openai", model: "two words" },
    { provider: "openai", model: "x".repeat(201) },
    { provider: "openai", model: "gpt-5", reasoning: "high" },
  ])("answers 400 to %j", async (payload, { tx }) => {
    const { request, signedIn } = start(tx);
    const admin = await signedIn({ admin: true });

    const res = await request(
      "PUT",
      "/admin/ai/models/default",
      admin.token,
      payload,
    );

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
  });
});
