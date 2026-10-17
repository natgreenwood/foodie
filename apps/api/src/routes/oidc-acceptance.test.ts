import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { oidcIdentity, user } from "../db/schema.js";
import { dbTest } from "../test/db.js";

dbTest(
  "starts the real server without any OIDC variables and refuses all OIDC actions",
  async ({ database }) => {
    const reservation = createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, "127.0.0.1", resolve),
    );
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    // Deliberately construct the environment: none of the four required
    // OIDC variables, or optional OIDC variables, is inherited.
    // From source through tsx, as `pnpm dev` runs it, so the suite needs
    // no build first.
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/server.ts"],
      {
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: process.env.TEST_DATABASE_URL,
          SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
          HOST: "127.0.0.1",
          PORT: String(port),
          NODE_ENV: "development",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    let accountId: number | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("startup timed out")),
          5000,
        );
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("server exited before readiness"));
        });
        child.once("error", reject);
        child.stderr.resume();
        child.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("Server listening at")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const origin = `http://127.0.0.1:${port}`;
      expect(await (await fetch(`${origin}/health`)).json()).toEqual({
        status: "ok",
        db: "up",
      });
      expect(await (await fetch(`${origin}/auth/oidc/config`)).json()).toEqual({
        enabled: false,
        displayName: null,
      });
      const created = await fetch(`${origin}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: `off-${randomUUID()}@example.com`,
          password: "test-password",
        }),
      });
      expect(created.status).toBe(201);
      await created.json();
      const cookie = created.headers.getSetCookie()[0]!.split(";")[0]!;
      const me = (await (
        await fetch(`${origin}/me`, { headers: { cookie } })
      ).json()) as { id: number };
      accountId = me.id;
      for (const [method, path] of [
        ["GET", "/auth/oidc/start"],
        ["GET", "/auth/oidc/callback?code=test-code&state=test-state"],
        ["POST", "/auth/oidc/connect"],
      ] as const) {
        const res = await fetch(origin + path, {
          method,
          headers: { cookie },
          redirect: "manual",
        });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({
          error: "not_found",
          message: "oidc sign-in is not configured",
        });
        expect(res.headers.getSetCookie()).toEqual([]);
      }
      for (const [method, path] of [
        ["POST", "/auth/oidc/connect"],
        ["DELETE", "/auth/oidc/connection"],
      ] as const) {
        expect((await fetch(origin + path, { method })).status).toBe(401);
      }
      // A disabled provider can retain previously connected identities.
      await database.db.insert(oidcIdentity).values({
        userId: accountId,
        issuer: "https://id.example.com",
        subject: "test-subject",
      });
      const disconnected = await fetch(`${origin}/auth/oidc/connection`, {
        method: "DELETE",
        headers: { cookie },
      });
      const remaining = await database.db
        .select()
        .from(oidcIdentity)
        .where(eq(oidcIdentity.userId, accountId));
      expect({
        status: disconnected.status,
        remaining: remaining.length,
      }).toEqual({ status: 404, remaining: 1 });
    } finally {
      child.kill("SIGTERM");
      await exited;
      if (accountId !== undefined)
        await database.db.delete(user).where(eq(user.id, accountId));
    }
  },
);
