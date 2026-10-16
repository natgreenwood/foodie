# Import: fetching a page

`fetchPage(url, deps, opts)` in `fetch.ts` returns a recipe page's HTML. It
stores nothing as a recipe.

1. The URL is normalised (`normaliseUrl`): scheme and host lowercased, the
   fragment, `utm_*` and `fbclid` parameters and a trailing slash on the path
   dropped. A URL that is not http or https, or carries credentials, is an
   `InvalidUrlError`.
2. A `page_fetch` row for the normalised URL less than 24 hours old is
   returned with `cached: true`. `{ refresh: true }` skips it.
3. Otherwise the strategies in `deps.strategies` are tried in order
   (`defaultStrategies`: plain HTTP with a Chrome user agent, then impit with
   a Firefox fingerprint). A 2xx is stored in `page_fetch` and returned. A
   response `cloudflareBlock` recognises (`cf-mitigated: challenge`, or a 403
   or 503 with `server: cloudflare`) moves on to the next strategy. Anything
   else ends the attempt:
   - 402: `NotPermittedError`. Sites such as AllRecipes use it to refuse
     automated access; it is never retried.
   - no response, 403, any other non-2xx, or the last strategy blocked:
     `FetchFailedError` with a `reason` of `unreachable`, `challenged`,
     `blocked` or `http_error`.

Each error's message carries the URL, the final status and what every
strategy got, so one log line is enough to see what happened.

## Checking against a real Cloudflare site (manual, not in CI)

The tests fake impit and never leave localhost. Whether impit gets past
Cloudflare depends on where the request comes from: NATG-201 measured it from
a residential IP only. Before relying on it from a new host, run this from
that host, in the built api image so the same impit binary is used:

```sh
docker build -f apps/api/Dockerfile -t foodie-api .
docker run --rm foodie-api node --input-type=module -e '
  import { defaultStrategies } from "./dist/import/fetch.js";
  import { cloudflareBlock } from "./dist/import/fetch/cloudflare.js";
  const url = process.argv[1];
  for (const s of defaultStrategies) {
    const res = await s.fetch(url).catch((err) => ({ err }));
    console.log(s.name, res.err ? String(res.err) : `${res.status} ${cloudflareBlock(res) ?? "ok"} ${res.body.length} bytes`);
  }' "https://www.example-recipe-site.com/some-recipe"
```

Use a recipe page you know is behind a Cloudflare challenge. Record the date,
host, URL and each line of output in the issue. `http 403 challenged` then
`impit 200 ok` is the result the fallback depends on; `impit 403 challenged`
from the deployment host means it needs the parked headless Chromium story.
