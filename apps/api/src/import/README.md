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
     hold them), then it is stored in `page_fetch` and returned. The same
     transaction deletes rows 24 hours old or more, then the oldest rows
     beyond `MAX_CACHED_PAGES` (500), never the one just written.
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
reserved, IPv4-mapped IPv6, or unique-local or link-local IPv6. It also
refuses benchmarking, IETF protocol assignment, IPv4-compatible and
site-local addresses, and the NAT64, 6to4 and Teredo translator prefixes
whatever IPv4 address they carry (NATG-270). `NON_PUBLIC` in
`fetch/destination.ts` is the authoritative list. A refused
URL is a `FetchFailedError` with `reason: "blocked_destination"`; nothing
is sent to it, no other strategy is tried and nothing is stored. A host
that does not resolve is `unreachable`, as before.

The strategies never follow a redirect themselves. `fetchPage` follows at
most 5 (`MAX_REDIRECTS`), checking each new location against the policy;
the sixth is a `FetchFailedError` with `reason: "too_many_redirects"`. The
returned and stored `finalUrl` is the last hop's.

impit keeps one cookie jar (tough-cookie) for all the hops of one
`fetchPage` call, so a consent page that sets a cookie and redirects gets it
back on the next hop, on the same host or, for a `Domain` cookie, a sibling
such as `www.` to the bare name. The jar's own rules keep a cookie from any
other host, and it is dropped when the call ends: nothing carries over to
another call (NATG-271). The http strategy keeps no cookies.

The policy also decides which addresses the request goes to: it returns
the ones it checked, and the http strategy (`node:http` / `node:https`)
connects only to those, through a `lookup` that answers with them. The host
is not resolved a second time, so a DNS server that answers with a public
address for the check and a private one afterwards (rebinding) cannot steer
it inward (NATG-268). The Host header, TLS server name and certificate check
still use the URL's host name.

A cached page is served only if its URL passes the policy now, so a row
stored before destinations were checked cannot return an internal page.

**Residual risk: DNS rebinding through impit.** impit takes no resolver, so
it resolves the host again to connect and the window above stays open on
that strategy. It is accepted (NATG-267); egress rules on the container
network are what close it.

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
  import { defaultDestinationPolicy } from "./dist/import/fetch/destination.js";
  const url = process.argv[1];
  const check = await defaultDestinationPolicy(new URL(url));
  if (check.refused) throw new Error(check.refused);
  for (const s of defaultStrategies) {
    const res = await s.fetch(url, check.addresses).catch((err) => ({ err }));
    console.log(s.name, res.err ? String(res.err) : `${res.status} ${cloudflareBlock(res) ?? "ok"} ${res.body.length} bytes`);
  }' "https://www.example-recipe-site.com/some-recipe"
```

Use a recipe page you know is behind a Cloudflare challenge. Record the date,
host, URL and each line of output in the issue. `http 403 challenged` then
`impit 200 ok` is the result the fallback depends on; `impit 403 challenged`
from the deployment host means it needs the parked headless Chromium story.

## Reading a page with no structured data (AI)

When `extractRecipe` finds neither JSON-LD nor microdata, the preview hands
the page to `extractRecipeWithAi` in `extract/ai.ts` (NATG-248). A page past
the extraction budget is not handed on; it is still `no_recipe_found`.

1. The page's visible text is taken: `head`, `script`, `style` and the like
   removed, and so is every element the markup hides, with all inside it:
   the `hidden` attribute, `aria-hidden="true"`, or an inline style of
   `display: none` or `visibility: hidden` in any case or spacing, with or
   without `!important`, once `/* */` comments are taken out (NATG-360).
   A line break comes only where a block element ends, or where the source
   has one inside a `<pre>` or an element with an inline `white-space` of
   `pre`, `pre-wrap` or `pre-line` (NATG-363); any other line break in the
   HTML source is a space, as a browser shows it. The cells of a table row
   share one line, as a browser shows them, so `1` | `1/2 cup flour` reads
   "1 1/2 cup flour" (NATG-359). Whitespace in each line is
   collapsed, blank lines dropped, and the text cut at a line to 40,000
   characters (`MAX_PAGE_TEXT_CHARS`). That one text is both what the model
   is sent and what its answer is checked against. Out of scope (NATG-360
   ruling): an element hidden by a class and a stylesheet, which would mean
   evaluating the CSS, and other inline hiding such as `opacity: 0`, a zero
   size, off-screen positioning or `clip`. The check stops the model
   inventing text; a page that means to mislead can as well show a false
   recipe in plain view. A page with no text (an app that renders in the
   browser) makes no completion and is `no_recipe_found`.
2. One completion through `complete()` with procedure `default`, so the
   model the admin chose for it. The prompt tells the model to copy the
   title, ingredient lines and steps character for character and never to
   invent, complete, reword or convert anything, and to answer
   `{"recipe": null}` when there is no recipe.
3. The answer is used only if every ingredient line and every step is in the
   page text. Both sides go through `normalise` first: NFKC (NBSP and other
   fixed-width spaces, ligatures, full-width letters), curly quotes to
   straight, whitespace collapsed. Nothing else is forgiven: case, dashes,
   spelling and numbers must match. A line that starts or ends with a
   letter or digit must do so at a word boundary in the page, and no line
   may start or end next to a digit, `/`, a fraction character, a hyphen or
   an en dash, nor next to a `.` or `,` with a digit on its far side
   (NATG-359), so "25 g" is not found in "225 g", nor "1 g" in "0.1 g",
   "5 kg" in "1,5 kg", "2 cup" in "1/2 cup" or "2 eggs" in "1-2 eggs". A
   line that starts with a digit may not start right after a `.` or `,`
   either, so "5 tsp" is not found in ".5 tsp". A line that starts with a
   number may not follow a number and spaces on the same page line, and
   one that ends with a number may not be followed by spaces and a number:
   "1/2 cups" is not found in "1 1/2 cups", nor "Bake for 1" in "Bake for
   1 1/2 hours". A line break ends that rule, so "2 eggs" is found on the
   line after "Serves 4"; elsewhere a space in a line matches a line break
   on the page. A copy that stops short of
   a comma or full stop is still found ("55 g butter" from "55 g butter,
   cubed", or a step without its last full stop). Steps must be found in the
   page's order, each after the end of the one before; two adjacent steps
   given as one are still found. Ingredient lines may come in any order.
   One line not found and the whole answer is dropped.
   A title not in the page is replaced by the page's `<title>`; servings,
   times and tags are left empty for the cook.
4. A used answer's lines go through the same line parser and ingredient
   match as structured data's, with `extraction: "ai"`.

Every answer is recorded in `ai_extraction`: the URL, provider, model, the
page text exactly as sent, the model's raw output (with any NUL characters
removed, as `fetchPage` does for HTML: Postgres `text` cannot hold them; the
answer is read with them removed too) and the `outcome`
(`accepted`, `ungrounded`, `no_recipe` or `unreadable`). Rows are kept
permanently; nothing prunes them. Nothing is recorded when no completion
was made.

| What happened                         | Preview answer          |
| ------------------------------------- | ----------------------- |
| Answer used                           | 200, `extraction: "ai"` |
| No text, no recipe, or answer dropped | 404 `no_recipe_found`   |
| No model chosen or no credential      | 503 `ai_not_configured` |
| Provider failed (`AiProviderError`)   | 502 `ai_failed`         |
| Anything else, recording included     | 500 `internal_error`    |

Each answer is logged with its `aiExtractionId` and `outcome`, and for a
dropped one the positions of the lines not found, never their text. A retry
makes, pays for and records another completion.

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

## Reversing the measurement key migration (manual)

To undo `drizzle/0006_measurement_key.sql`, while it is still the latest
migration applied, run against the database:

```sql
begin;
alter table measurement drop column key;
delete from drizzle.__drizzle_migrations where created_at = 1792184379834;
commit;
```

Dropping the column drops its unique index with it. `1792184379834` is the
`when` of `0006_measurement_key` in `drizzle/meta/_journal.json`. The
measurement lookup selects the column, so deploy code from before the
migration first or every import preview fails.

## Reversing the ai_extraction migration (manual)

To undo `drizzle/0016_ai_extraction.sql`, while it is still the latest
migration applied, run against the database:

```sql
begin;
drop table ai_extraction;
delete from drizzle.__drizzle_migrations where created_at = 1792547333159;
commit;
```

`1792547333159` is the `when` of `0016_ai_extraction` in
`drizzle/meta/_journal.json`. The table holds the only copy of every AI
reading, so export it first if it may be wanted. Deploy code from before the
migration first: this code writes to the table on every AI reading, and
without it those previews fail with 500.
