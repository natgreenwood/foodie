import { connect } from "node:net";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildApp } from "../app.js";
import { createSession } from "../auth/accounts.js";
import { createDatabase } from "../db/client.js";
import { user } from "../db/schema.js";
import { testDatabaseUrl } from "../test/env.js";
import { SESSION_COOKIE } from "./auth.js";

// SEC-1 over a real socket: a request that passed the admin guard but holds
// back its body must not act once its sender has been disabled or demoted.
// Commits for real (two connections must see each other's writes) and
// deletes what it made afterwards.

const database = createDatabase(testDatabaseUrl(), (err) => {
  console.error("postgres idle client error:", err.message);
});
const { db } = database;
const made: number[] = [];
const unused = () => Promise.reject(new Error("not used by these tests"));

let app: FastifyInstance;
let port: number;
// Called with the url of each request once its onRequest hooks (requireUser,
// requireAdmin) have passed and its body is about to be read.
let onBodyWait: (url: string) => void = () => undefined;

beforeAll(async () => {
  app = buildApp({
    pingDatabase: () => Promise.resolve(),
    fetchPage: unused,
    loadUnits: unused,
    matchIngredients: unused,
    extractWithAi: unused,
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
  await app.close();
  if (made.length > 0) await db.delete(user).where(inArray(user.id, made));
  await database.close();
});

async function signedInAdmin(): Promise<{ id: number; token: string }> {
  const [row] = await db
    .insert(user)
    .values({
      email: `admin-${crypto.randomUUID()}@admin-race-routes.test`,
      isAdmin: true,
    })
    .returning({ id: user.id });
  if (!row) throw new Error("user insert returned no row");
  made.push(row.id);
  const { token } = await createSession(db, row.id);
  return { id: row.id, token };
}

function post(path: string, token: string) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

// Sends the headers and the first byte of a JSON body, waits until the
// server is reading the body, runs `meanwhile`, then sends the rest. Resolves
// with the response's status code.
async function slowBodyPost(
  path: string,
  token: string,
  meanwhile: () => Promise<void>,
): Promise<number> {
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
      `POST ${path} HTTP/1.1`,
      "Host: 127.0.0.1",
      `Cookie: ${SESSION_COOKIE}=${token}`,
      "Content-Type: application/json",
      "Content-Length: 2",
      "Connection: close",
      "",
      "{",
    ].join("\r\n"),
  );
  await reading;
  await meanwhile();
  socket.write("}");
  const raw = await response;
  const status = /^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1];
  if (!status) throw new Error("no HTTP status line in the response");
  return Number(status);
}

async function state(id: number) {
  const [row] = await db
    .select({ isAdmin: user.isAdmin, disabledAt: user.disabledAt })
    .from(user)
    .where(eq(user.id, id));
  return row;
}

describe("a held-back request from an admin (SEC-1)", () => {
  test("cannot re-enable its sender after they are disabled", async () => {
    const mallory = await signedInAdmin();
    const other = await signedInAdmin();

    const status = await slowBodyPost(
      `/admin/users/${mallory.id}/enable`,
      mallory.token,
      async () => {
        const res = await post(
          `/admin/users/${mallory.id}/disable`,
          other.token,
        );
        expect(res.status).toBe(200);
      },
    );

    expect(status).toBe(401);
    expect((await state(mallory.id))?.disabledAt).not.toBeNull();
  });

  test("cannot re-grant its sender the admin role after it is revoked", async () => {
    const mallory = await signedInAdmin();
    const other = await signedInAdmin();

    const status = await slowBodyPost(
      `/admin/users/${mallory.id}/grant-admin`,
      mallory.token,
      async () => {
        const res = await post(
          `/admin/users/${mallory.id}/revoke-admin`,
          other.token,
        );
        expect(res.status).toBe(200);
      },
    );

    expect(status).toBe(403);
    expect((await state(mallory.id))?.isAdmin).toBe(false);
  });
});
