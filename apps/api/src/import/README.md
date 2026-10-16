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
   a Firefox fingerprint). Each reads at most 5 MB (`MAX_BODY_BYTES`) of the
   body and stops there. Each request, and each of up to 5 redirects
   (`MAX_REDIRECTS`), goes only to a destination the policy allows; see
   [Destinations](#destinations). A response `cloudflareBlock` recognises
   (`cf-mitigated: challenge` whatever the status, even 200, or a 403 or 503
   with `server: cloudflare`) moves on to the next strategy. Anything else
   ends the attempt:
   - 2xx with a `content-type` of `text/html` or `application/xhtml+xml` and
     a body within the cap: NUL bytes are removed (Postgres `text` cannot
     hold them), then it is stored in `page_fetch` and returned.
   - 2xx with any other or no `content-type` (a PDF, an image):
     `FetchFailedError` with `reason: "not_html"`.
   - 2xx over the cap: `FetchFailedError` with `reason: "too_large"`.
   - 402: `NotPermittedError`. Sites such as AllRecipes use it to refuse
     automated access; it is never retried.
   - no response, more than 5 redirects, 403, any other non-2xx, or the
     last strategy blocked: `FetchFailedError` with a `reason` of
     `unreachable`, `challenged`, `blocked` or `http_error`.

   Nothing is stored for any error.

Each error's message carries the URL, the final status and what every
strategy got, so one log line is enough to see what happened.

## Destinations

A user supplies the URL, so without a check the api would fetch whatever it
names: its own database, the cloud metadata service at `169.254.169.254`, or
anything else on the host's network (SEC-1, NATG-268). `deps.destination`
(`publicOnly` by default, `fetch/destination.ts`) decides where a fetch may
connect:

- Only `http:` and `https:`.
- `localhost` and names ending `.localhost` are refused without resolving.
- An IP literal is checked as it is, after the URL parser normalises it
  (`http://2130706433/` is `127.0.0.1`). Any other name is resolved with
  `dns.lookup` and refused if any address it returns is refused.
- Refused: loopback, private (including IPv6 `fc00::/7`), link-local, CGNAT
  (`100.64.0.0/10`), unspecified (`0.0.0.0/8`, `::`), multicast, and the
  IPv4-mapped IPv6 form of each IPv4 range.

The check runs before the first request and again for every redirect, which
fetchPage follows itself (neither transport follows redirects on its own). A
refusal is an `InvalidUrlError` with the message `destination not allowed`;
the refused host is not named, so the caller learns nothing about the
network.

The http strategy connects only to the addresses that were checked: it
passes them to `node:http` / `node:https` as the `lookup`, so the name is not
resolved again. impit resolves the name itself and cannot be given an
address, so between the check and impit's connect a DNS answer can change
(rebinding) and point it at a refused address. That is accepted as residual
risk. The defence in depth is egress filtering on the container's network:
the api container should not be able to reach private ranges or the metadata
service at all. That is a deployment concern, not something this code can
enforce.

The tests run their fixture server on `127.0.0.1`, so they pass a policy
that allows it; `publicOnly` itself is tested in
`fetch/destination.test.ts`.

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
  import { publicOnly, resolveDestination } from "./dist/import/fetch/destination.js";
  const url = process.argv[1];
  const addresses = await resolveDestination(new URL(url), publicOnly);
  if (!addresses) throw new Error("destination not allowed");
  for (const s of defaultStrategies) {
    const res = await s.fetch(url, addresses).catch((err) => ({ err }));
    console.log(s.name, res.err ? String(res.err) : `${res.status} ${cloudflareBlock(res) ?? "ok"} ${res.body.length} bytes`);
  }' "https://www.example-recipe-site.com/some-recipe"
```

Each strategy makes one request and does not follow redirects, so use the
page's final URL. Use a recipe page you know is behind a Cloudflare
challenge. Record the date,
host, URL and each line of output in the issue. `http 403 challenged` then
`impit 200 ok` is the result the fallback depends on; `impit 403 challenged`
from the deployment host means it needs the parked headless Chromium story.

## Reversing the page_fetch migration (manual)

Drizzle has no down migrations. To undo `drizzle/0005_page_fetch.sql`, while
it is still the latest migration applied, run against the database:

```sql
begin;
drop table page_fetch;
delete from drizzle.__drizzle_migrations where created_at = 1792163049551;
commit;
```

`1792163049551` is the `when` of `0005_page_fetch` in
`drizzle/meta/_journal.json`, which Drizzle stores as `created_at`; it is
the last row of `drizzle.__drizzle_migrations`. If later migrations have
been applied, reverse those first. The cached pages are lost, which costs
only a refetch.
