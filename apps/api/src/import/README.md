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
   body and stops there. A response `cloudflareBlock` recognises
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
   - no response, 403, any other non-2xx, or the last strategy blocked:
     `FetchFailedError` with a `reason` of `unreachable`, `challenged`,
     `blocked` or `http_error`.

   Nothing is stored for any error.

## Destinations and redirects

Every request a strategy makes, the first and each redirect hop, is checked
first against `deps.destinationPolicy` (`fetch/destination.ts`). The
default, `publicOnly()`, allows only http and https to a host whose every
address is public: it resolves the host with `dns.lookup` (all records) and
refuses if any one is loopback, private (RFC 1918), CGNAT, link-local
(including the 169.254.169.254 metadata service), multicast, unspecified,
reserved, IPv4-mapped IPv6, or unique-local or link-local IPv6. A refused
URL is a `FetchFailedError` with `reason: "blocked_destination"`; nothing
is sent to it, no other strategy is tried and nothing is stored. A host
that does not resolve is `unreachable`, as before.

The strategies never follow a redirect themselves. `fetchPage` follows at
most 5 (`MAX_REDIRECTS`), checking each new location against the policy;
the sixth is a `FetchFailedError` with `reason: "too_many_redirects"`. The
returned and stored `finalUrl` is the last hop's.

**Residual risk: DNS rebinding.** The policy resolves the host, then the
strategy resolves it again to connect. A DNS server that answers with a
public address the first time and a private one the second can still steer
a request inward. Pinning the checked address needs a resolver hook that
impit does not have, and Node's `fetch` takes one only through undici's
`Agent`, which would be a new dependency, so the window is accepted. Egress
rules on the container network are what close it.

Tests fetch from fixtures on `127.0.0.1`, which the default refuses, so they
pass a policy that allows that host and applies `publicOnly` with a fake
resolver to every other.

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
