import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { pipeline, Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Address } from "./destination.js";
import {
  FETCH_TIMEOUT_MS,
  readCapped,
  type FetchStrategy,
} from "./strategy.js";

// A desktop Chrome's headers, as in the NATG-201 baseline: some sites refuse
// Node's default user agent outright.
const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
  // What global fetch sent, decoded below as it did.
  "accept-encoding": "gzip, deflate, br",
};

// node:http rather than global fetch, which cannot be told which address to
// connect to (SEC-1, NATG-268). The connection goes only to `addresses`, the
// ones fetchPage checked, so the name is not resolved a second time and a DNS
// answer that changes in between (rebinding) is never used. TLS still
// verifies the certificate against the URL's host name.
export const httpStrategy: FetchStrategy = {
  name: "http",
  async fetch(url, addresses) {
    const res = await get(new URL(url), addresses);
    const body = Readable.toWeb(decoded(res)) as ReadableStream<Uint8Array>;
    const bytes = await readCapped(body);
    return {
      status: res.statusCode ?? 0,
      finalUrl: url,
      headers: toHeaders(res.rawHeaders),
      // UTF-8, as res.text() would decode it.
      body: bytes ? new TextDecoder().decode(bytes) : "",
      tooLarge: bytes === null,
    };
  },
};

function get(
  url: URL,
  addresses: readonly Address[],
): Promise<IncomingMessage> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        headers: BROWSER_HEADERS,
        lookup: pinnedLookup(addresses),
        // Covers the body too: it aborts the response stream being read.
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

// A dns.lookup stand-in that answers with `addresses` whatever it is asked.
// Node asks for all of them when it races IPv4 and IPv6 (autoSelectFamily),
// otherwise for one.
function pinnedLookup(addresses: readonly Address[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [...addresses]);
    } else {
      const [first] = addresses;
      if (first) callback(null, first.address, first.family);
      else callback(new Error("no address to connect to"), "", 0);
    }
  };
}

// The body with any content-encoding we asked for removed. A decoding error
// destroys the returned stream, so reading it rejects.
function decoded(res: IncomingMessage): Readable {
  const encoding = res.headers["content-encoding"]?.trim().toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? createGunzip()
      : encoding === "deflate"
        ? createInflate()
        : encoding === "br"
          ? createBrotliDecompress()
          : null;
  return decoder ? pipeline(res, decoder, () => undefined) : res;
}

// rawHeaders is [name, value, name, value, ...] with repeats kept.
function toHeaders(raw: readonly string[]): Headers {
  const headers = new Headers();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    headers.append(raw[i] as string, raw[i + 1] as string);
  }
  return headers;
}
