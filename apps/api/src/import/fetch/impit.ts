import { Impit } from "impit";
import {
  FETCH_TIMEOUT_MS,
  readCapped,
  type FetchStrategy,
} from "./strategy.js";

// impit sends a real Firefox's TLS and HTTP/2 fingerprint and headers, which
// gets past Cloudflare challenges a plain fetch does not (NATG-201). A new
// instance per fetch, so one site's cookies are never sent to another.
export const impitStrategy: FetchStrategy = {
  name: "impit",
  async fetch(url) {
    const impit = new Impit({
      browser: "firefox",
      timeout: FETCH_TIMEOUT_MS,
      followRedirects: true,
    });
    const res = await impit.fetch(url);
    const bytes = await readCapped(res.body);
    return {
      status: res.status,
      finalUrl: res.url || url,
      headers: res.headers,
      // decodeBuffer is what res.text() uses: it honours the page's charset.
      body: bytes ? res.decodeBuffer(bytes) : "",
      tooLarge: bytes === null,
    };
  },
};
