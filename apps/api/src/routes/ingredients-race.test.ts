import { connect } from "node:net";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildApp } from "../app.js";
import { createSession, sessionId } from "../auth/accounts.js";
import { createDatabase, type Database } from "../db/client.js";
import { addIngredientName, MAX_NAMES } from "../db/ingredients.js";
import { ingredient, ingredientName, user } from "../db/schema.js";
import { testDatabaseUrl } from "../test/env.js";
import { dropDatabase, recreateDatabase } from "../test/global-setup.js";
import { SESSION_COOKIE } from "./auth.js";

// SEC-1 and SEC-2 for the catalogue writes, over a real socket: a request
// that passed requireUser but holds back its body must not change an
// ingredient once its sender has been demoted, disabled or signed out; and
// simultaneous adds cannot pass the name limit. Commits for real (two
// connections must see each other's writes), so it runs on a database of
// its own, made and dropped here: every other file's list tests would see
// a committed ingredient in the shared one.

const url = new URL(testDatabaseUrl());
url.pathname = url.pathname.replace(/_test$/, "_ingredient_race_test");
let database: Database;
let db: Database["db"];
const unused = () => Promise.reject(new Error("not used by these tests"));

let app: FastifyInstance;
let port: number;
// Called with the url of each request once its onRequest hooks have passed
// and its body is about to be read.
let onBodyWait: (url: string) => void = () => undefined;

beforeAll(async () => {
  await recreateDatabase(url.toString());
  database = createDatabase(url.toString(), (err) => {
    console.error("postgres idle client error:", err.message);
  });
  db = database.db;
  app = buildApp({
    pingDatabase: () => Promise.resolve(),
    fetchPage: unused,
    loadUnits: unused,
    matchIngredients: unused,
    db,
    secureCookies: false,
    settingsKey: Buffer.alloc(32),
  });
  // preParsing runs after every onRequest hook, before the body is read.
  app.addHook("preParsing", async (request, _reply, payload) => {
    onBodyWait(request.url);
    return payload;
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server has no port");
  }
  port = address.port;
});

afterAll(async () => {
  await app?.close();
  await database?.close();
  await dropDatabase(url.toString());
});

async function signedInUser({ isAdmin = false } = {}): Promise<{
  id: number;
  token: string;
}> {
  const [row] = await db
    .insert(user)
    .values({
      email: `cook-${crypto.randomUUID()}@ingredient-race-routes.test`,
      isAdmin,
    })
    .returning({ id: user.id });
  if (!row) throw new Error("user insert returned no row");
  const { token } = await createSession(db, row.id);
  return { id: row.id, token };
}

// An ingredient with `count` en-GB names, the first canonical.
async function newIngredient(
  createdBy: number | null,
  count = 1,
): Promise<number> {
  const [row] = await db
    .insert(ingredient)
    .values({ createdBy, category: "before", source: "seed" })
    .returning({ id: ingredient.id });
  if (!row) throw new Error("ingredient insert returned no row");
  await db.insert(ingredientName).values(
    Array.from({ length: count }, (_, i) => ({
      ingredientId: row.id,
      name: `race ${row.id} ${i}`,
      locale: "en-GB",
      isCanonical: i === 0,
    })),
  );
  return row.id;
}

function post(path: string, token: string, body?: unknown) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE}=${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// Sends the headers and all but the last byte of a JSON body, waits until
// the server is reading the body, runs `meanwhile`, then sends the rest.
// Resolves with the response's status code.
async function slowBodyRequest(
  method: string,
  path: string,
  token: string,
  body: unknown,
  meanwhile: () => Promise<void>,
): Promise<number> {
  const json = JSON.stringify(body);
  const reading = new Promise<void>((resolve) => {
    onBodyWait = (url) => {
      if (url === path) resolve();
    };
  });
  const socket = connect(port, "127.0.0.1");
  const response = new Promise<string>((resolve, reject) => {
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
  socket.write(
    [
      `${method} ${path} HTTP/1.1`,
      "Host: 127.0.0.1",
      `Cookie: ${SESSION_COOKIE}=${token}`,
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(json)}`,
      "Connection: close",
      "",
      json.slice(0, -1),
    ].join("\r\n"),
  );
  await reading;
  await meanwhile();
  socket.write(json.slice(-1));
  const raw = await response;
  const status = /^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1];
  if (!status) throw new Error("no HTTP status line in the response");
  return Number(status);
}

async function category(id: number) {
  const [row] = await db
    .select({ category: ingredient.category })
    .from(ingredient)
    .where(eq(ingredient.id, id));
  return row?.category;
}

describe("a held-back catalogue write (SEC-1)", () => {
  // What another admin does to the sender while the body is held back, and
  // the status the write then gets.
  test.for([
    [
      "demoted",
      (other: string, id: number) =>
        post(`/admin/users/${id}/revoke-admin`, other),
      403,
    ],
    [
      "disabled",
      (other: string, id: number) => post(`/admin/users/${id}/disable`, other),
      401,
    ],
    [
      "signed out",
      (_other: string, _id: number, own: string) => post("/auth/logout", own),
      401,
    ],
  ] as const)(
    "to a prebuilt ingredient is refused once its admin sender is %s",
    async ([, revoke, expected]) => {
      const mallory = await signedInUser({ isAdmin: true });
      const other = await signedInUser({ isAdmin: true });
      const id = await newIngredient(null);

      const status = await slowBodyRequest(
        "PATCH",
        `/ingredients/${id}`,
        mallory.token,
        { category: "changed" },
        async () => {
          const res = await revoke(other.token, mallory.id, mallory.token);
          expect(res.ok).toBe(true);
        },
      );

      expect(status).toBe(expected);
      expect(await category(id)).toBe("before");
    },
  );

  test("from a creator who has never been an admin still goes through", async () => {
    const creator = await signedInUser();
    const id = await newIngredient(creator.id);

    const status = await slowBodyRequest(
      "PATCH",
      `/ingredients/${id}`,
      creator.token,
      { category: "changed" },
      () => Promise.resolve(),
    );

    expect(status).toBe(200);
    expect(await category(id)).toBe("changed");
  });
});

// Resolves once some query on this database is waiting for a lock, or
// after two seconds, whichever is first.
async function someoneWaitsForALock(): Promise<void> {
  for (let tries = 0; tries < 40; tries++) {
    const { rows } = await db.execute<{ waiting: number }>(sql`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
    `);
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("simultaneous adds (SEC-2)", () => {
  test(`two adds to an ingredient with ${MAX_NAMES - 1} names end with ${MAX_NAMES}`, async () => {
    // Two different users, so nothing but the ingredient lock orders them:
    // lockActor locks each sender's own row.
    const creator = await signedInUser();
    const admin = await signedInUser({ isAdmin: true });
    const id = await newIngredient(creator.id, MAX_NAMES - 1);
    const actor = (who: { id: number; token: string }) => ({
      userId: who.id,
      sessionId: sessionId(who.token),
    });

    // The first add is held open after it has counted and inserted, until
    // the second is waiting on a lock, so the two overlap every run.
    let second: Promise<unknown> | undefined;
    const first = await db.transaction(async (tx) => {
      const outcome = await addIngredientName(tx, actor(creator), id, {
        name: `race ${id} extra 1`,
        locale: "en-GB",
      });
      second = addIngredientName(db, actor(admin), id, {
        name: `race ${id} extra 2`,
        locale: "en-GB",
      });
      await someoneWaitsForALock();
      return outcome;
    });

    expect(first).toHaveProperty("changed");
    expect(await second).toEqual({ nameLimit: true });
    const names = await db
      .select({ id: ingredientName.id })
      .from(ingredientName)
      .where(eq(ingredientName.ingredientId, id));
    expect(names).toHaveLength(MAX_NAMES);
  });

  test("an add over HTTP at the limit answers 409 name_limit", async () => {
    const creator = await signedInUser();
    const id = await newIngredient(creator.id, MAX_NAMES);

    const res = await post(`/ingredients/${id}/names`, creator.token, {
      name: `race ${id} extra`,
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "name_limit" });
  });
});
