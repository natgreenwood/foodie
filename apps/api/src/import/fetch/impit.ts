import { Impit } from "impit";
import { CookieJar } from "tough-cookie";
import { decodeBody } from "./decode.js";
import {
  FETCH_TIMEOUT_MS,
  readCapped,
  type FetchSession,
  type FetchStrategy,
} from "./strategy.js";

// impit sends a real Firefox's TLS and HTTP/2 fingerprint and headers, which
// gets past Cloudflare challenges a plain fetch does not (NATG-201).
//
// One instance and one cookie jar per session, that is per fetchPage call, so
// a cookie a consent page sets on one hop is sent on the next, as a browser
// would (NATG-271). tough-cookie's domain and path rules keep it to the hosts
// it was set for, and the jar goes when the call ends. impit keeps no cookies
// without a jar.
//
// `proxyUrl` is for tests: through a loopback proxy, hostnames need no DNS.
export function createImpitStrategy(
  options: { proxyUrl?: string } = {},
): FetchStrategy {
  function session(): FetchSession {
    const impit = new Impit({
      browser: "firefox",
      timeout: FETCH_TIMEOUT_MS,
      // fetchPage follows redirects itself, so it can check each hop.
      followRedirects: false,
      cookieJar: new CookieJar(),
      ...options,
    });
    return {
      async fetch(url) {
        const res = await impit.fetch(url);
        const bytes = await readCapped(res.body);
        return {
          status: res.status,
          headers: res.headers,
          body: bytes ? decodeBody(bytes, res.headers.get("content-type")) : "",
          tooLarge: bytes === null,
        };
      },
    };
  }
  return {
    name: "impit",
    fetch: (url, addresses) => session().fetch(url, addresses),
    session,
  };
}

export const impitStrategy = createImpitStrategy();
