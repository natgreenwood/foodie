import { eq } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { describeError } from "../db/errors.js";
import { pageFetch } from "../db/schema.js";
import type * as schema from "../db/schema.js";
import { cloudflareBlock } from "./fetch/cloudflare.js";
import { httpStrategy } from "./fetch/http.js";
import { impitStrategy } from "./fetch/impit.js";
import type {
  FetchResponse,
  FetchStrategy,
  StrategyName,
} from "./fetch/strategy.js";

export type { FetchStrategy, StrategyName } from "./fetch/strategy.js";

// Plain HTTP first; impit only when Cloudflare stops it (NATG-239).
export const defaultStrategies: readonly FetchStrategy[] = [
  httpStrategy,
  impitStrategy,
];

export const CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface FetchedPage {
  html: string;
  finalUrl: string;
  status: number;
  strategy: StrategyName;
  fetchedAt: Date;
  cached: boolean;
}

export interface FetchPageDeps {
  // The api's database or a transaction on it.
  db: PgDatabase<NodePgQueryResultHKT, typeof schema>;
  strategies: readonly FetchStrategy[];
  now?: () => Date;
}

export interface FetchPageOptions {
  // Skip the cache and overwrite it with the new fetch.
  refresh?: boolean;
}

export class InvalidUrlError extends Error {
  override name = "InvalidUrlError";
}

// HTTP 402: the site refuses automated access as a licensing matter
// (AllRecipes, Serious Eats and others). Final: no other strategy is tried.
export class NotPermittedError extends Error {
  override name = "NotPermittedError";
  readonly status = 402;
  constructor(
    readonly url: string,
    readonly strategy: StrategyName,
  ) {
    super(`${url} does not permit import: HTTP 402 to ${strategy}`);
  }
}

// - unreachable: the request failed without a response (refused, DNS,
//   timeout).
// - challenged: Cloudflare still served a challenge to the last strategy.
// - blocked: a 403, or a 503 from a Cloudflare edge.
// - http_error: any other non-2xx status, such as 404 or 500.
export type FetchFailureReason =
  "unreachable" | "challenged" | "blocked" | "http_error";

export class FetchFailedError extends Error {
  override name = "FetchFailedError";
  constructor(
    readonly url: string,
    readonly reason: FetchFailureReason,
    // The last strategy's HTTP status; null if it got no response.
    readonly status: number | null,
    // One entry per strategy tried, for example "http: 403 challenged".
    readonly attempts: readonly string[],
    options?: ErrorOptions,
  ) {
    super(
      `could not fetch ${url}: ${reason}, final status ${status ?? "none"} (${attempts.join("; ")})`,
      options,
    );
  }
}

// Lowercases scheme and host (URL does this), drops the fragment, utm_* and
// fbclid query parameters, and a trailing slash on the path. Everything else,
// including the order and encoding of the other parameters, is kept.
export function normaliseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new InvalidUrlError(`invalid URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidUrlError(
      `invalid URL: ${url.protocol} is not http or https (${JSON.stringify(raw)})`,
    );
  }
  // Not echoed: they would put a password in the log line.
  if (url.username !== "" || url.password !== "") {
    throw new InvalidUrlError("invalid URL: must not contain credentials");
  }

  url.hash = "";
  if (url.search !== "") {
    const kept = url.search
      .slice(1)
      .split("&")
      .filter((pair) => {
        const key = decodeQueryKey(pair.split("=", 1)[0] ?? "").toLowerCase();
        return !key.startsWith("utm_") && key !== "fbclid";
      });
    url.search = kept.length > 0 ? `?${kept.join("&")}` : "";
  }
  // The root path is always "/" in a URL, so only longer paths lose theirs.
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  }
  return url.toString();
}

function decodeQueryKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, " "));
  } catch {
    return key;
  }
}

// The page at `rawUrl`, from the page_fetch cache if it was fetched in the
// last 24 hours, otherwise from the first strategy that gets it. Rejects with
// InvalidUrlError, NotPermittedError or FetchFailedError. Database errors are
// not caught.
export async function fetchPage(
  rawUrl: string,
  deps: FetchPageDeps,
  opts: FetchPageOptions = {},
): Promise<FetchedPage> {
  const url = normaliseUrl(rawUrl);
  const now = deps.now ?? (() => new Date());

  if (!opts.refresh) {
    const [hit] = await deps.db
      .select()
      .from(pageFetch)
      .where(eq(pageFetch.normalisedUrl, url));
    if (hit && now().getTime() - hit.fetchedAt.getTime() < CACHE_LIFETIME_MS) {
      return {
        html: hit.html,
        finalUrl: hit.finalUrl,
        status: hit.status,
        strategy: hit.strategy as StrategyName,
        fetchedAt: hit.fetchedAt,
        cached: true,
      };
    }
  }

  const res = await fetchWithStrategies(url, deps.strategies);
  const row = {
    normalisedUrl: url,
    finalUrl: res.finalUrl,
    status: res.status,
    strategy: res.strategy,
    html: res.body,
    fetchedAt: now(),
  };
  // An upsert, so a retry or a refresh overwrites rather than conflicts.
  await deps.db
    .insert(pageFetch)
    .values(row)
    .onConflictDoUpdate({ target: pageFetch.normalisedUrl, set: row });
  return {
    html: row.html,
    finalUrl: row.finalUrl,
    status: row.status,
    strategy: row.strategy,
    fetchedAt: row.fetchedAt,
    cached: false,
  };
}

async function fetchWithStrategies(
  url: string,
  strategies: readonly FetchStrategy[],
): Promise<FetchResponse & { strategy: StrategyName }> {
  const attempts: string[] = [];
  let failure: FetchFailedError | undefined;

  for (const strategy of strategies) {
    let res: FetchResponse;
    try {
      res = await strategy.fetch(url);
    } catch (err) {
      // No response at all; nothing suggests another strategy would differ.
      attempts.push(`${strategy.name}: ${describeError(err)}`);
      throw new FetchFailedError(url, "unreachable", null, attempts, {
        cause: err,
      });
    }

    if (res.status === 402) throw new NotPermittedError(url, strategy.name);
    if (res.status >= 200 && res.status < 300) {
      return { ...res, strategy: strategy.name };
    }

    const block = cloudflareBlock(res);
    attempts.push(`${strategy.name}: ${res.status}${block ? ` ${block}` : ""}`);
    const reason: FetchFailureReason =
      block ?? (res.status === 403 ? "blocked" : "http_error");
    failure = new FetchFailedError(url, reason, res.status, attempts);
    // Only a Cloudflare block is worth another strategy: a 404 or the
    // site's own 500 would be the same whoever asked.
    if (!block) throw failure;
  }

  throw failure ?? new FetchFailedError(url, "unreachable", null, attempts);
}
