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
};

export const httpStrategy: FetchStrategy = {
  name: "http",
  async fetch(url) {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      // fetchPage follows redirects itself, so it can check each hop.
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const bytes = await readCapped(res.body);
    return {
      status: res.status,
      headers: res.headers,
      // UTF-8, as res.text() would decode it.
      body: bytes ? new TextDecoder().decode(bytes) : "",
      tooLarge: bytes === null,
    };
  },
};
