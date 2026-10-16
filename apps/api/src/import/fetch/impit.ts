import { Impit } from "impit";
import {
  FETCH_TIMEOUT_MS,
  readCapped,
  type FetchStrategy,
} from "./strategy.js";

// impit sends a real Firefox's TLS and HTTP/2 fingerprint and headers, which
// gets past Cloudflare challenges a plain fetch does not (NATG-201). A new
// instance per fetch, so one site's cookies are never sent to another.
//
// impit resolves the host itself and cannot be given an address, so unlike
// the http strategy it ignores `addresses`: a DNS answer that changes between
// fetchPage's check and impit's connect (rebinding) is not caught here
// (SEC-1, NATG-268). Accepted as residual risk; egress filtering on the
// container network is the defence in depth.
export const impitStrategy: FetchStrategy = {
  name: "impit",
  async fetch(url) {
    const impit = new Impit({
      browser: "firefox",
      timeout: FETCH_TIMEOUT_MS,
      // fetchPage follows redirects, checking each destination first.
      followRedirects: false,
    });
    const res = await impit.fetch(url);
    const bytes = await readCapped(res.body);
    return {
      status: res.status,
      finalUrl: url,
      headers: res.headers,
      // decodeBuffer is what res.text() uses: it honours the page's charset.
      body: bytes ? res.decodeBuffer(bytes) : "",
      tooLarge: bytes === null,
    };
  },
};
