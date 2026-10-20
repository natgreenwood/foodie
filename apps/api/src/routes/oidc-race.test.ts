import { gt, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "../app.js";
import { sessionId } from "../auth/accounts.js";
import { oidcProvider } from "../auth/oidc-provider.js";
import { createDatabase } from "../db/client.js";
import { oidcLogin } from "../db/schema.js";
import { testDatabaseUrl } from "../test/env.js";
import {
  startMockProvider,
  type MockProvider,
} from "../test/oidc-provider-mock.js";
import { OIDC_COOKIE } from "./oidc.js";

// SEC-1 over real sockets and real connections: concurrent starts must not
// take the trips in progress past OIDC_MAX_PENDING_LOGINS. Commits for real
// (each start's transaction must see the others') and deletes what it made
// afterwards.

const database = createDatabase(testDatabaseUrl(), (err) => {
  console.error("postgres idle client error:", err.message);
});
const { db } = database;
const unused = () => Promise.reject(new Error("not used by these tests"));
const made: string[] = [];
const ROOM = 5;
const STARTS = 30;

let mock: MockProvider;
let app: FastifyInstance;
let port: number;
let baseline: number;

async function inProgress(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(oidcLogin)
    .where(gt(oidcLogin.expiresAt, sql`now()`));
  return row?.n ?? 0;
}

beforeAll(async () => {
  mock = await startMockProvider();
  // Rows other files commit would count too; they write none, but measure.
  baseline = await inProgress();
  app = buildApp({
    pingDatabase: () => Promise.resolve(),
    fetchPage: unused,
    loadUnits: unused,
    matchIngredients: unused,
    extractWithAi: unused,
    db,
    secureCookies: false,
    settingsKey: Buffer.alloc(32),
    oidc: oidcProvider({
      id: "generic",
      issuerUrl: mock.issuer,
      clientId: mock.clientId,
      clientSecret: mock.clientSecret,
      redirectUrl: new URL("http://localhost:5173/api/auth/oidc/callback"),
      displayName: null,
      maxPendingLogins: baseline + ROOM,
      // Out of the way: this is the aggregate bound's test.
      startsPerMinute: 1000,
    }),
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no port");
  }
  port = address.port;
});

afterAll(async () => {
  await app.close();
  if (made.length > 0) {
    await db.delete(oidcLogin).where(inArray(oidcLogin.id, made));
  }
  await mock.close();
  await database.close();
});

test("concurrent starts cannot take the trips in progress past the bound", async () => {
  // Discovery once first, so every start below reaches the database at
  // about the same moment.
  const warm = await fetch(`http://127.0.0.1:${port}/auth/oidc/start`, {
    redirect: "manual",
  });
  expect(warm.status).toBe(302);

  const responses = await Promise.all(
    Array.from({ length: STARTS }, () =>
      fetch(`http://127.0.0.1:${port}/auth/oidc/start`, { redirect: "manual" }),
    ),
  );
  for (const res of [warm, ...responses]) {
    const cookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${OIDC_COOKIE}=`));
    if (cookie) made.push(sessionId(cookie.split(";")[0]!.split("=")[1]!));
  }

  const statuses = responses.map((r) => r.status);
  expect(statuses.filter((s) => s === 302)).toHaveLength(ROOM - 1);
  expect(statuses.filter((s) => s === 429)).toHaveLength(STARTS - ROOM + 1);
  expect(made).toHaveLength(ROOM);
  expect(await inProgress()).toBe(baseline + ROOM);
});
