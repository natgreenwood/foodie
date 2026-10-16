import { eq } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { describeError } from "../db/errors.js";
import { pageFetch } from "../db/schema.js";
import type * as schema from "../db/schema.js";
import { cloudflareBlock } from "./fetch/cloudflare.js";
import {
  defaultDestinationPolicy,
  type DestinationPolicy,
} from "./fetch/destination.js";
import { httpStrategy } from "./fetch/http.js";
import { impitStrategy } from "./fetch/impit.js";
import {
  MAX_BODY_BYTES,
  type FetchResponse,
  type FetchStrategy,
  type StrategyName,
} from "./fetch/strategy.js";

export type { FetchStrategy, StrategyName } from "./fetch/strategy.js";
export type { DestinationPolicy } from "./fetch/destination.js";

// Plain HTTP first; impit only when Cloudflare stops it (NATG-239).
export const defaultStrategies: readonly FetchStrategy[] = [
  httpStrategy,
  impitStrategy,
];

export const CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000;

// Redirects followed per strategy; the next one fails too_many_redirects.
export const MAX_REDIRECTS = 5;

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
  // Checked before every request. Defaults to public addresses only; tests
  // that fetch from a loopback fixture pass one that allows it.
  destinationPolicy?: DestinationPolicy;
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
// - blocked_destination: the URL, or a redirect from it, is not a public
//   http or https address. Nothing was sent to it.
// - too_many_redirects: more than MAX_REDIRECTS redirects.
// - challenged: Cloudflare still served a challenge to the last strategy.
// - blocked: a 403, or a 503 from a Cloudflare edge.
// - http_error: any other non-2xx status, such as 404 or 500.
// - not_html: a 2xx whose content-type is not HTML, such as a PDF or image.
// - too_large: a 2xx whose body passed MAX_BODY_BYTES.
export type FetchFailureReason =
  | "unreachable"
  | "blocked_destination"
  | "too_many_redirects"
  | "challenged"
  | "blocked"
  | "http_error"
  | "not_html"
  | "too_large";

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

  const res = await fetchWithStrategies(
    url,
    deps.strategies,
    deps.destinationPolicy ?? defaultDestinationPolicy,
  );
  const row = {
    normalisedUrl: url,
    finalUrl: res.finalUrl,
    status: res.status,
    strategy: res.strategy,
    // Postgres text cannot hold NUL, and no HTML needs one.
    html: res.body.replaceAll("\u0000", ""),
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
  policy: DestinationPolicy,
): Promise<FetchResponse & { finalUrl: string; strategy: StrategyName }> {
  const attempts: string[] = [];
  let failure: FetchFailedError | undefined;

  for (const strategy of strategies) {
    const res = await fetchFollowingRedirects(url, strategy, policy, attempts);

    // Before the 2xx check: Cloudflare can serve a challenge with a 200
    // (NATG-258), and that page must not be returned or cached.
    const block = cloudflareBlock(res);
    if (res.status === 402) throw new NotPermittedError(url, strategy.name);
    if (!block && res.status >= 200 && res.status < 300) {
      // Final: another strategy would get the same file.
      const contentType = mediaType(res.headers);
      if (!HTML_TYPES.has(contentType)) {
        attempts.push(
          `${strategy.name}: ${res.status} not_html (${contentType || "no content-type"})`,
        );
        throw new FetchFailedError(url, "not_html", res.status, attempts);
      }
      if (res.tooLarge) {
        attempts.push(
          `${strategy.name}: ${res.status} too_large (over ${MAX_BODY_BYTES} bytes)`,
        );
        throw new FetchFailedError(url, "too_large", res.status, attempts);
      }
      return { ...res, strategy: strategy.name };
    }

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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// `strategy`'s response from `url` after following at most MAX_REDIRECTS
// redirects, with the URL it came from. Every hop, the first included, is
// checked against `policy` before it is requested, so a refused destination
// is never sent anything. Each failure is final, as unreachable is: another
// strategy would be sent to the same place.
async function fetchFollowingRedirects(
  url: string,
  strategy: FetchStrategy,
  policy: DestinationPolicy,
  attempts: string[],
): Promise<FetchResponse & { finalUrl: string }> {
  let current = new URL(url);
  // The redirect that led to `current`, for the error; null on the first.
  let via: number | null = null;
  for (let redirects = 0; ; redirects++) {
    // The host only: a redirect's path and query are the remote's to choose
    // and need not be in the log.
    const hop = via === null ? "" : ` ${via} to ${current.host},`;
    let refused: string | null;
    try {
      refused = await policy(current);
    } catch (err) {
      attempts.push(`${strategy.name}:${hop} ${describeError(err)}`);
      throw new FetchFailedError(url, "unreachable", via, attempts, {
        cause: err,
      });
    }
    if (refused) {
      attempts.push(`${strategy.name}:${hop} blocked_destination (${refused})`);
      throw new FetchFailedError(url, "blocked_destination", via, attempts);
    }

    let res: FetchResponse;
    try {
      res = await strategy.fetch(current.toString());
    } catch (err) {
      // No response at all; nothing suggests another strategy would differ.
      attempts.push(`${strategy.name}:${hop} ${describeError(err)}`);
      throw new FetchFailedError(url, "unreachable", via, attempts, {
        cause: err,
      });
    }

    // A 3xx without a location is an answer, judged like any other status.
    const location = res.headers.get("location");
    if (!REDIRECT_STATUSES.has(res.status) || location === null) {
      return { ...res, finalUrl: current.toString() };
    }
    if (redirects === MAX_REDIRECTS) {
      attempts.push(
        `${strategy.name}: ${res.status} too_many_redirects (over ${MAX_REDIRECTS})`,
      );
      throw new FetchFailedError(
        url,
        "too_many_redirects",
        res.status,
        attempts,
      );
    }
    try {
      current = new URL(location, current);
    } catch {
      attempts.push(`${strategy.name}: ${res.status} to an invalid location`);
      throw new FetchFailedError(url, "http_error", res.status, attempts);
    }
    via = res.status;
  }
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

// "text/html; charset=utf-8" -> "text/html"; "" when there is no header.
function mediaType(headers: Headers): string {
  const [type = ""] = (headers.get("content-type") ?? "").split(";", 1);
  return type.trim().toLowerCase();
}
