import { readFile } from "node:fs/promises";
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
  MAX_REDIRECTS,
  normaliseUrl,
  NotPermittedError,
  type DestinationPolicy,
  type FetchStrategy,
  type StrategyName,
} from "./fetch.js";
import { cloudflareBlock } from "./fetch/cloudflare.js";
import { publicOnly, type Resolver } from "./fetch/destination.js";
import { httpStrategy } from "./fetch/http.js";
import { impitStrategy } from "./fetch/impit.js";
import { MAX_BODY_BYTES } from "./fetch/strategy.js";

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
        headers: new Headers({ "content-type": "text/html" }),
        body: "<html>from impit</html>",
      });
    },
  };
}

// Records what it is asked for and answers every URL with a page, so a test
// can see whether a request would have been sent at all.
function recorder(name: StrategyName): FetchStrategy & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    calls,
    fetch(url) {
      calls.push(url);
      return Promise.resolve({
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
        body: `<html>from ${name}</html>`,
      });
    },
  };
}

// Stands in for DNS, so no test depends on what a real name resolves to.
const DNS: Record<string, string[]> = {
  "recipes.test": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
  "internal.test": ["10.1.2.3"],
  // One private record among public ones is enough to refuse.
  "mixed.test": ["93.184.215.14", "192.168.0.5"],
};
const fakeDns: Resolver = (host) =>
  DNS[host]
    ? Promise.resolve(DNS[host])
    : Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`));
const strictWithFakeDns = publicOnly(fakeDns);

// The fixtures listen on 127.0.0.1, which the default policy refuses. Every
// other host goes through the real policy, on the fake DNS.
const allowFixtures: DestinationPolicy = (url) =>
  url.hostname === "127.0.0.1" ? Promise.resolve(null) : strictWithFakeDns(url);

// A real image, as a recipe URL that points at a photo would return. Its
// bytes include NULs.
const PNG = await readFile(new URL("./fixtures/tomato.png", import.meta.url));
// "<h>", NUL, "A": the smallest body that broke the page_fetch insert.
const NUL_BODY = Buffer.from([0x3c, 0x68, 0x3e, 0x00, 0x41]);

// Each path answers with its own status, headers and static body (the shared
// FIXTURE_BODY unless it names one): request input is recorded below, never
// echoed back.
const routes: Record<
  string,
  { status: number; headers?: object; body?: string | Buffer }
> = {
  "/ok": { status: 200 },
  "/challenge": { status: 403, headers: { "cf-mitigated": "challenge" } },
  "/cf-403": { status: 403, headers: { server: "cloudflare" } },
  "/cf-503": { status: 503, headers: { server: "cloudflare" } },
  "/origin-403": { status: 403, headers: { server: "nginx" } },
  "/missing": { status: 404 },
  "/licensed": { status: 402 },
  "/challenge-200": { status: 200, headers: { "cf-mitigated": "challenge" } },
  "/xhtml": {
    status: 200,
    headers: { "content-type": "application/xhtml+xml; charset=utf-8" },
  },
  "/png": { status: 200, headers: { "content-type": "image/png" }, body: PNG },
  "/png-as-html": { status: 200, body: PNG },
  "/nul": { status: 200, body: NUL_BODY },
  "/at-cap": { status: 200, body: Buffer.alloc(MAX_BODY_BYTES, "a") },
  "/over-cap": { status: 200, body: Buffer.alloc(MAX_BODY_BYTES + 1, "a") },
  "/to-metadata": {
    status: 302,
    headers: { location: "http://169.254.169.254/latest/meta-data/" },
  },
  "/to-internal": {
    status: 301,
    headers: { location: "http://internal.test/admin" },
  },
  "/to-ftp": { status: 302, headers: { location: "ftp://example.com/pie" } },
  // /hops/n redirects n times, by relative location, before a page.
  "/hops/0": { status: 200 },
  ...Object.fromEntries(
    Array.from({ length: MAX_REDIRECTS + 1 }, (_, i) => [
      `/hops/${i + 1}`,
      { status: 307, headers: { location: `/hops/${i}` } },
    ]),
  ),
};
const FIXTURE_BODY = "<html>fixture</html>";
const requests: string[] = [];
const userAgents: (string | undefined)[] = [];
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    userAgents.push(req.headers["user-agent"]);
    const route = routes[req.url ?? ""] ?? { status: 500 };
    res.writeHead(route.status, {
      "content-type": "text/html",
      ...route.headers,
    });
    res.end(route.body ?? FIXTURE_BODY);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function deps(tx: TestTransaction, impit = fakeImpit(), now = new Date()) {
  return {
    db: tx,
    strategies: [httpStrategy, impit],
    now: () => now,
    destinationPolicy: allowFixtures,
  };
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
    userAgents.length = 0;

    const page = await fetchPage(`${base}/ok`, deps(tx, impit));

    expect(page).toMatchObject({
      status: 200,
      strategy: "http",
      cached: false,
    });
    expect(page.finalUrl).toBe(`${base}/ok`);
    expect(page.html).toBe(FIXTURE_BODY);
    expect(userAgents).toEqual([expect.stringContaining("Chrome/")]);
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

  dbTest(
    "falls back to impit on a 200 challenge (NATG-258)",
    async ({ tx }) => {
      const impit = fakeImpit();

      const page = await fetchPage(`${base}/challenge-200`, deps(tx, impit));

      expect(page).toMatchObject({
        strategy: "impit",
        html: "<html>from impit</html>",
      });
      const rows = await tx.select().from(pageFetch);
      expect(rows.map((r) => r.strategy)).toEqual(["impit"]);
    },
  );

  dbTest("never caches a 200 challenge", async ({ tx }) => {
    const impit: FetchStrategy = {
      name: "impit",
      fetch: () =>
        Promise.resolve({
          status: 200,
          headers: new Headers({
            "content-type": "text/html",
            "cf-mitigated": "challenge",
          }),
          body: "<html>just a moment</html>",
        }),
    };

    const err = await fetchPage(`${base}/challenge-200`, {
      db: tx,
      strategies: [httpStrategy, impit],
      destinationPolicy: allowFixtures,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FetchFailedError);
    expect(err).toMatchObject({ reason: "challenged", status: 200 });
    expect((err as Error).message).toContain(
      "http: 200 challenged; impit: 200 challenged",
    );
    expect(await tx.select().from(pageFetch)).toEqual([]);
  });

  dbTest("fails challenged when impit is challenged too", async ({ tx }) => {
    const impit: FetchStrategy = {
      name: "impit",
      fetch: () =>
        Promise.resolve({
          status: 403,
          headers: new Headers({ "cf-mitigated": "challenge" }),
          body: "",
        }),
    };

    const err = await fetchPage(`${base}/challenge`, {
      db: tx,
      strategies: [httpStrategy, impit],
      destinationPolicy: allowFixtures,
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

describe("fetchPage bodies", () => {
  dbTest("accepts application/xhtml+xml", async ({ tx }) => {
    const page = await fetchPage(`${base}/xhtml`, deps(tx));

    expect(page).toMatchObject({ strategy: "http", html: FIXTURE_BODY });
  });

  dbTest(
    "fails not_html on an image, without impit or a cache row",
    async ({ tx }) => {
      const impit = fakeImpit();

      const err = await fetchPage(`${base}/png`, deps(tx, impit)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(FetchFailedError);
      expect(err).toMatchObject({ reason: "not_html", status: 200 });
      expect((err as Error).message).toContain(
        "http: 200 not_html (image/png)",
      );
      expect(impit.calls).toEqual([]);
      expect(await tx.select().from(pageFetch)).toEqual([]);
    },
  );

  dbTest(
    "fails too_large over the cap, without impit or a cache row",
    async ({ tx }) => {
      const impit = fakeImpit();

      const err = await fetchPage(`${base}/over-cap`, deps(tx, impit)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(FetchFailedError);
      expect(err).toMatchObject({ reason: "too_large", status: 200 });
      expect((err as Error).message).toContain(
        `http: 200 too_large (over ${MAX_BODY_BYTES} bytes)`,
      );
      expect(impit.calls).toEqual([]);
      expect(await tx.select().from(pageFetch)).toEqual([]);
    },
  );

  dbTest("accepts a body exactly at the cap", async ({ tx }) => {
    const page = await fetchPage(`${base}/at-cap`, deps(tx));

    expect(page.html).toHaveLength(MAX_BODY_BYTES);
  });

  dbTest("strips a NUL byte, then returns and caches", async ({ tx }) => {
    const page = await fetchPage(`${base}/nul`, deps(tx));

    expect(page).toMatchObject({ html: "<h>A", cached: false });
    const rows = await tx.select().from(pageFetch);
    expect(rows.map((r) => r.html)).toEqual(["<h>A"]);
  });

  dbTest("strips NULs from a real PNG sent as text/html", async ({ tx }) => {
    expect(PNG.includes(0)).toBe(true);

    const page = await fetchPage(`${base}/png-as-html`, deps(tx));

    expect(page.html).not.toContain("\u0000");
    expect(page.html.length).toBeGreaterThan(0);
    const rows = await tx.select().from(pageFetch);
    expect(rows.map((r) => r.html)).toEqual([page.html]);
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
    expect(page.html).toBe(FIXTURE_BODY);
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

describe("fetchPage destinations", () => {
  dbTest(
    "refuses the loopback fixture under the default policy",
    async ({ tx }) => {
      const impit = fakeImpit();
      requests.length = 0;

      const err = await fetchPage(`${base}/ok`, {
        db: tx,
        strategies: [httpStrategy, impit],
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FetchFailedError);
      expect(err).toMatchObject({
        reason: "blocked_destination",
        status: null,
      });
      expect((err as Error).message).toContain(
        "http: blocked_destination (127.0.0.1 is loopback 127.0.0.0/8)",
      );
      expect(requests).toEqual([]);
      expect(impit.calls).toEqual([]);
      expect(await tx.select().from(pageFetch)).toEqual([]);
    },
  );

  dbTest.for([
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::ffff:127.0.0.1]/",
    "http://100.64.0.1/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://0.0.0.0/",
    // Decimal 127.0.0.1, which URL rewrites to the dotted form.
    "http://2130706433/",
    // Resolved by the real lookup, from the hosts file.
    "http://localhost/",
    // NAT64, 6to4 and Teredo wrapping a private IPv4 address (NATG-270).
    "http://[64:ff9b::a00:1]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[64:ff9b:1::a00:1]/",
    "http://[2002:a9fe:a9fe::1]/",
    "http://[2002:7f00:1::]/",
    "http://[2001:0:a00:1::1]/",
    "http://198.18.0.1/",
    "http://192.0.0.1/",
    "http://[fec0::1]/",
    // IPv4-compatible, which URL rewrites to ::7f00:1.
    "http://[::127.0.0.1]/",
  ])(
    "refuses %s under the default policy before any request",
    async (url, { tx }) => {
      const http = recorder("http");
      const impit = recorder("impit");

      const err = await fetchPage(url, {
        db: tx,
        strategies: [http, impit],
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FetchFailedError);
      expect(err).toMatchObject({ reason: "blocked_destination" });
      expect(http.calls).toEqual([]);
      expect(impit.calls).toEqual([]);
      expect(await tx.select().from(pageFetch)).toEqual([]);
    },
  );

  dbTest.for(["internal.test", "mixed.test"])(
    "refuses %s, which resolves to a private address",
    async (host, { tx }) => {
      const http = recorder("http");

      const err = await fetchPage(`http://${host}/pie`, {
        db: tx,
        strategies: [http],
        destinationPolicy: strictWithFakeDns,
      }).catch((e: unknown) => e);

      expect(err).toMatchObject({ reason: "blocked_destination" });
      expect((err as Error).message).toContain(`${host} resolves to `);
      expect(http.calls).toEqual([]);
    },
  );

  dbTest("allows a host whose every address is public", async ({ tx }) => {
    const http = recorder("http");

    const page = await fetchPage("https://recipes.test/pie", {
      db: tx,
      strategies: [http],
      destinationPolicy: strictWithFakeDns,
    });

    expect(page).toMatchObject({ strategy: "http", cached: false });
    expect(http.calls).toEqual(["https://recipes.test/pie"]);
  });

  dbTest("fails unreachable when the host does not resolve", async ({ tx }) => {
    const http = recorder("http");

    await expect(
      fetchPage("https://nowhere.test/pie", {
        db: tx,
        strategies: [http],
        destinationPolicy: strictWithFakeDns,
      }),
    ).rejects.toMatchObject({ reason: "unreachable", status: null });
    expect(http.calls).toEqual([]);
  });

  dbTest.for([
    ["/to-metadata", "302 to 169.254.169.254"],
    ["/to-internal", "301 to internal.test"],
    ["/to-ftp", "302 to example.com"],
  ])(
    "refuses a redirect %s and caches nothing",
    async ([path, hop], { tx }) => {
      const impit = fakeImpit();

      const err = await fetchPage(`${base}${path}`, deps(tx, impit)).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(FetchFailedError);
      expect(err).toMatchObject({ reason: "blocked_destination" });
      expect((err as Error).message).toContain(
        `http: ${hop}, blocked_destination`,
      );
      expect(impit.calls).toEqual([]);
      expect(await tx.select().from(pageFetch)).toEqual([]);
    },
  );

  dbTest(`follows ${MAX_REDIRECTS} redirects`, async ({ tx }) => {
    requests.length = 0;

    const page = await fetchPage(`${base}/hops/${MAX_REDIRECTS}`, deps(tx));

    expect(page).toMatchObject({ status: 200, html: FIXTURE_BODY });
    expect(page.finalUrl).toBe(`${base}/hops/0`);
    expect(requests).toHaveLength(MAX_REDIRECTS + 1);
    const rows = await tx.select().from(pageFetch);
    expect(rows.map((r) => [r.normalisedUrl, r.finalUrl])).toEqual([
      [`${base}/hops/${MAX_REDIRECTS}`, `${base}/hops/0`],
    ]);
  });

  dbTest(
    `fails too_many_redirects on ${MAX_REDIRECTS + 1}, caching nothing`,
    async ({ tx }) => {
      const impit = fakeImpit();
      requests.length = 0;

      const err = await fetchPage(
        `${base}/hops/${MAX_REDIRECTS + 1}`,
        deps(tx, impit),
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FetchFailedError);
      expect(err).toMatchObject({ reason: "too_many_redirects", status: 307 });
      // The sixth redirect is not followed.
      expect(requests).toHaveLength(MAX_REDIRECTS + 1);
      expect(impit.calls).toEqual([]);
      expect(await tx.select().from(pageFetch)).toEqual([]);
    },
  );

  dbTest(
    "checks a redirect impit gets after the http fallback",
    async ({ tx }) => {
      const impit: FetchStrategy & { calls: string[] } = {
        name: "impit",
        calls: [],
        fetch(url) {
          this.calls.push(url);
          return Promise.resolve({
            status: 302,
            headers: new Headers({ location: "http://10.0.0.1/" }),
            body: "",
          });
        },
      };

      const err = await fetchPage(`${base}/challenge`, deps(tx, impit)).catch(
        (e: unknown) => e,
      );

      expect(err).toMatchObject({ reason: "blocked_destination", status: 302 });
      expect((err as Error).message).toContain(
        "http: 403 challenged; impit: 302 to 10.0.0.1, blocked_destination",
      );
      expect(impit.calls).toEqual([`${base}/challenge`]);
      expect(await tx.select().from(pageFetch)).toEqual([]);
    },
  );

  dbTest.for([httpStrategy, impitStrategy])(
    "the real $name strategy returns a redirect rather than following it",
    async (strategy, { tx }) => {
      const err = await fetchPage(`${base}/to-metadata`, {
        db: tx,
        strategies: [strategy],
        destinationPolicy: allowFixtures,
      }).catch((e: unknown) => e);

      expect(err).toMatchObject({ reason: "blocked_destination", status: 302 });
      expect((err as Error).message).toContain(
        `${strategy.name}: 302 to 169.254.169.254, blocked_destination`,
      );
    },
  );
});
