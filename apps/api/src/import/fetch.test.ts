import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pageFetch } from "../db/schema.js";
import { dbTest, type TestTransaction } from "../test/db.js";
import {
  CACHE_LIFETIME_MS,
  FetchFailedError,
  fetchPage,
  InvalidUrlError,
  normaliseUrl,
  NotPermittedError,
  type FetchStrategy,
} from "./fetch.js";
import { cloudflareBlock } from "./fetch/cloudflare.js";
import { httpStrategy } from "./fetch/http.js";

// Stands in for impit: CI never reaches a real site.
function fakeImpit(status = 200): FetchStrategy & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "impit",
    calls,
    fetch(url) {
      calls.push(url);
      return Promise.resolve({
        status,
        finalUrl: url,
        headers: new Headers(),
        body: "<html>from impit</html>",
      });
    },
  };
}

// Each path answers with its own status and headers; requests are counted.
const routes: Record<string, { status: number; headers?: object }> = {
  "/ok": { status: 200 },
  "/challenge": { status: 403, headers: { "cf-mitigated": "challenge" } },
  "/cf-403": { status: 403, headers: { server: "cloudflare" } },
  "/cf-503": { status: 503, headers: { server: "cloudflare" } },
  "/origin-403": { status: 403, headers: { server: "nginx" } },
  "/missing": { status: 404 },
  "/licensed": { status: 402 },
};
const requests: string[] = [];
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    const route = routes[req.url ?? ""] ?? { status: 500 };
    res.writeHead(route.status, {
      "content-type": "text/html",
      ...route.headers,
    });
    res.end(`<html>${req.url} ${req.headers["user-agent"]}</html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function deps(tx: TestTransaction, impit = fakeImpit(), now = new Date()) {
  return { db: tx, strategies: [httpStrategy, impit], now: () => now };
}

describe("normaliseUrl", () => {
  it.each([
    ["HTTPS://Example.COM/Recipes/Pie", "https://example.com/Recipes/Pie"],
    ["https://example.com/pie#method", "https://example.com/pie"],
    ["https://example.com/pie/", "https://example.com/pie"],
    ["https://example.com/", "https://example.com/"],
    [
      "https://example.com/pie?utm_source=x&id=7&UTM_Medium=y&fbclid=abc&b=%20",
      "https://example.com/pie?id=7&b=%20",
    ],
    ["https://example.com/pie?utm_source=x", "https://example.com/pie"],
    ["https://example.com/pie?b=2&a=1", "https://example.com/pie?b=2&a=1"],
  ])("%s -> %s", (raw, expected) => {
    expect(normaliseUrl(raw)).toBe(expected);
  });

  it.each(["not a url", "ftp://example.com/pie", "javascript:alert(1)"])(
    "rejects %s",
    (raw) => {
      expect(() => normaliseUrl(raw)).toThrow(InvalidUrlError);
    },
  );

  it("rejects credentials without echoing them", () => {
    expect(() => normaliseUrl("https://me:hunter2@example.com/")).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("hunter2") as string,
      }),
    );
  });
});

describe("cloudflareBlock", () => {
  const res = (status: number, headers: Record<string, string>) => ({
    status,
    headers: new Headers(headers),
  });

  it("sees a challenge header whatever the status", () => {
    expect(cloudflareBlock(res(200, { "cf-mitigated": "challenge" }))).toBe(
      "challenged",
    );
  });

  it("sees a 403 or 503 from a Cloudflare edge as blocked", () => {
    expect(cloudflareBlock(res(403, { server: "cloudflare" }))).toBe("blocked");
    expect(cloudflareBlock(res(503, { server: "Cloudflare" }))).toBe("blocked");
  });

  it("ignores the same statuses from the site's own server", () => {
    expect(cloudflareBlock(res(403, { server: "nginx" }))).toBeNull();
    expect(cloudflareBlock(res(404, { server: "cloudflare" }))).toBeNull();
  });
});

describe("fetchPage strategies", () => {
  dbTest("returns a 200 from the http strategy", async ({ tx }) => {
    const impit = fakeImpit();

    const page = await fetchPage(`${base}/ok`, deps(tx, impit));

    expect(page).toMatchObject({
      status: 200,
      strategy: "http",
      cached: false,
    });
    expect(page.finalUrl).toBe(`${base}/ok`);
    expect(page.html).toContain("Chrome/");
    expect(impit.calls).toEqual([]);
  });

  dbTest.for(["/challenge", "/cf-403", "/cf-503"])(
    "falls back to impit on %s",
    async (path, { tx }) => {
      const impit = fakeImpit();

      const page = await fetchPage(`${base}${path}`, deps(tx, impit));

      expect(page).toMatchObject({
        strategy: "impit",
        html: "<html>from impit</html>",
      });
      expect(impit.calls).toEqual([`${base}${path}`]);
    },
  );

  dbTest("fails challenged when impit is challenged too", async ({ tx }) => {
    const impit: FetchStrategy = {
      name: "impit",
      fetch: (url) =>
        Promise.resolve({
          status: 403,
          finalUrl: url,
          headers: new Headers({ "cf-mitigated": "challenge" }),
          body: "",
        }),
    };

    const err = await fetchPage(`${base}/challenge`, {
      db: tx,
      strategies: [httpStrategy, impit],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FetchFailedError);
    expect(err).toMatchObject({ reason: "challenged", status: 403 });
    expect((err as Error).message).toContain(`${base}/challenge`);
    expect((err as Error).message).toContain(
      "http: 403 challenged; impit: 403 challenged",
    );
  });

  dbTest("treats 402 as final and does not try impit", async ({ tx }) => {
    const impit = fakeImpit();

    const err = await fetchPage(`${base}/licensed`, deps(tx, impit)).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(NotPermittedError);
    expect((err as Error).message).toContain(`${base}/licensed`);
    expect((err as Error).message).toContain("402");
    expect(impit.calls).toEqual([]);
  });

  dbTest("treats 402 from impit as final too", async ({ tx }) => {
    await expect(
      fetchPage(`${base}/challenge`, deps(tx, fakeImpit(402))),
    ).rejects.toBeInstanceOf(NotPermittedError);
  });

  dbTest("does not fall back on a 403 from the origin", async ({ tx }) => {
    const impit = fakeImpit();

    await expect(
      fetchPage(`${base}/origin-403`, deps(tx, impit)),
    ).rejects.toMatchObject({ reason: "blocked", status: 403 });
    expect(impit.calls).toEqual([]);
  });

  dbTest("fails http_error on a 404", async ({ tx }) => {
    await expect(fetchPage(`${base}/missing`, deps(tx))).rejects.toMatchObject({
      reason: "http_error",
      status: 404,
    });
  });

  dbTest("fails unreachable when the connection is refused", async ({ tx }) => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, "127.0.0.1", resolve),
    );
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const impit = fakeImpit();

    const err = await fetchPage(
      `http://127.0.0.1:${port}/pie`,
      deps(tx, impit),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FetchFailedError);
    expect(err).toMatchObject({ reason: "unreachable", status: null });
    expect((err as Error).message).toContain("ECONNREFUSED");
    expect(impit.calls).toEqual([]);
  });

  dbTest("does not cache a failure", async ({ tx }) => {
    await fetchPage(`${base}/missing`, deps(tx)).catch(() => undefined);

    expect(await tx.select().from(pageFetch)).toEqual([]);
  });
});

describe("fetchPage cache", () => {
  const now = new Date("2026-10-16T12:00:00Z");

  dbTest("serves a repeat within 24 hours from the cache", async ({ tx }) => {
    await fetchPage(`${base}/ok?utm_source=a`, deps(tx, fakeImpit(), now));
    requests.length = 0;

    const page = await fetchPage(
      `${base}/ok/#top`,
      deps(tx, fakeImpit(), new Date(now.getTime() + CACHE_LIFETIME_MS - 1)),
    );

    expect(page).toMatchObject({
      status: 200,
      strategy: "http",
      cached: true,
      fetchedAt: now,
    });
    expect(page.html).toContain("/ok");
    expect(requests).toEqual([]);
  });

  dbTest("refetches and overwrites with refresh", async ({ tx }) => {
    await fetchPage(`${base}/ok`, deps(tx, fakeImpit(), now));
    requests.length = 0;
    const later = new Date(now.getTime() + 1000);

    const page = await fetchPage(`${base}/ok`, deps(tx, fakeImpit(), later), {
      refresh: true,
    });

    expect(page).toMatchObject({ cached: false, fetchedAt: later });
    expect(requests).toEqual(["/ok"]);
    const rows = await tx.select().from(pageFetch);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fetchedAt).toEqual(later);
  });

  dbTest("refetches an entry 24 hours old", async ({ tx }) => {
    await fetchPage(`${base}/ok`, deps(tx, fakeImpit(), now));
    requests.length = 0;

    const page = await fetchPage(
      `${base}/ok`,
      deps(tx, fakeImpit(), new Date(now.getTime() + CACHE_LIFETIME_MS)),
    );

    expect(page.cached).toBe(false);
    expect(requests).toEqual(["/ok"]);
  });
});
