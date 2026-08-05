# CodFlow

A Cash-On-Delivery app for Shopify: a customizable COD order form that replaces
Add-to-Cart/Buy-Now, with Google Sheets sync, server-side pixel tracking, a
fraud-scoring engine, OTP verification and an embedded Polaris admin.

---

## Architecture

Three deployable units plus a shared contract package:

| Unit | Stack | Role |
|---|---|---|
| `apps/api` | Express 5, TypeScript, Prisma 6 | Admin REST API, storefront endpoints, webhook receivers, BullMQ workers |
| `apps/admin` | React 18, Polaris 13, App Bridge 4, Vite 8 | Embedded merchant UI, served inside the Shopify admin iframe |
| `extensions/` | Theme app extension, Web pixel extension | Storefront COD button/form, sandboxed pixel tracking |
| `packages/shared` | TypeScript, Zod | Enums, plan limits and request/response contracts used by all three |

### Request paths

There are two distinct traffic classes, and they authenticate differently:

1. **Admin traffic** — the embedded SPA calls `/api/admin/*` with an App Bridge
   session token in `Authorization: Bearer`. The API verifies the JWT signature
   against the app secret, then exchanges it for an offline access token.
2. **Storefront traffic** — a shopper's browser calls `/api/storefront/*` from
   the theme extension. These endpoints are public and unauthenticated, so they
   are the app's real attack surface: aggressively rate-limited, origin-checked
   against the shop domain, and never trusted to supply prices. Line-item pricing
   is always re-resolved from the Shopify Admin API server-side before an order
   is created.

### Layering

Each feature under `apps/api/src/modules/` is a vertical slice:

```
routes.ts       HTTP surface — paths, middleware, validation wiring
controller.ts   parse request -> call service -> shape response
service.ts      business logic, orchestration, transactions
repository.ts   Prisma queries. The only layer that imports PrismaClient
dto.ts          Zod schemas; inferred types are the module's public contract
```

The rule that keeps this honest: **controllers never import Prisma, and
repositories never import Express**. The fraud engine and sync engine are
therefore testable without an HTTP server or a live Shopify session.

Cross-cutting concerns live outside the modules:

```
config/       env parsing and validation — the process refuses to boot on a bad env
shopify/      shopifyApi instance, GraphQL client factory, webhook registry
db/           PrismaClient singleton
redis/        ioredis connections (one for cache, one for BullMQ)
queue/        queue definitions + worker entrypoint
jobs/         job processors (sheet sync, pixel dispatch, fraud rescan)
middlewares/  auth, rate limiting, error handling, audit logging
lib/          crypto (AES-256-GCM), mailer, HTTP client, pagination
```

### Why background jobs

Shopify requires a webhook response within 5 seconds. Every webhook handler
therefore does exactly two things: verify the HMAC, and enqueue. All real work —
writing a row to Google Sheets, firing a Conversions API event, rescoring an
order — happens in a BullMQ worker with retries and backoff. `WebhookEvent`
stores `shopifyWebhookId` under a unique constraint, so Shopify's at-least-once
delivery becomes effectively-once processing.

---

## Key decisions

These were chosen deliberately; changing them has consequences worth knowing.

**Prisma 6.19, not 7.** `@shopify/shopify-app-session-storage-prisma@9` peer-depends
on `prisma ^6.19.0` and imports `PrismaClient` from `@prisma/client`. Prisma 7's
generator emits to a local `output` directory instead of populating
`@prisma/client`, so the official session storage cannot resolve against it. The
alternative was hand-rolling OAuth session persistence — not a trade worth making.
Revisit when Shopify ships a Prisma 7 compatible release.

**`@shopify/shopify-api` v13 directly, not `shopify-app-express`.** Shopify no
longer recommends the Express wrapper for new apps, and its opinionated
middleware fights the layering above. Managed installation and token exchange are
implemented in `modules/auth`.

**Shopify App Pricing (managed), not `appSubscriptionCreate`.** The legacy Billing
API `charge_id` redirect and the `APP_SUBSCRIPTIONS_UPDATE` webhook were retired
on **2026-04-28**. Any tutorial predating that date describes dead code. Plan
state lives in Shopify and is read via the Partner API, then cached in
`Subscription`. This is why `SHOPIFY_PARTNER_API_TOKEN` is required for billing.

**React 18, not 19 — forced by Polaris.** `@shopify/polaris@13.9.5` (the latest
release) declares `peerDependencies: { react: "^18.0.0" }`. Installing React 19
fails resolution outright. Since Polaris is a hard requirement, React is pinned
to 18.3.1; every other frontend dependency accepts it (`app-bridge-react` peers
`react: "*"`, `react-router-dom` peers `>=18`, `react-query` peers `^18 || ^19`).
Do not "fix" this with `--legacy-peer-deps` — Polaris 13 is not tested against
React 19's stricter effect and ref semantics. Move to React 19 only when Polaris
ships a release that peers it.

**Admin API version is pinned to `2026-07`.** There is no `latest` alias, and
`@shopify/shopify-api` v13 removed the `LATEST_API_VERSION` export. Requesting a
retired version silently falls forward to the oldest supported one. Bump
quarterly, deliberately.

**App Bridge loads from Shopify's CDN, never bundled.** `index.html` loads
`https://cdn.shopify.com/shopifycloud/app-bridge.js` as the first script in
`<head>`. Shopify auto-updates that file; a vendored copy goes stale and embedded
features break in ways that are hard to diagnose.

---

## Authentication

There is no install endpoint. Under managed installation Shopify performs the
OAuth grant itself, so the **first authenticated request a shop makes is its
installation** — `authenticateAdmin` provisions the tenant as a side effect of
letting the request through.

The order inside that middleware is load-bearing:

```
1. verify the session token    cheap; rejects forgeries before any I/O
2. resolve an offline session  reuse storage, exchange only when necessary
3. provision the shop          idempotent; creates the tenant on first pass
4. confirm scopes              after the exchange, never before
```

Doing (4) before (2) is the classic bug: the stored session still shows the old
scopes, so the app sends a merchant through consent they just completed, and the
loop never terminates.

Session tokens live about a minute, so rejection is a *retryable* signal, not a
failure. The API answers 401 with `X-Shopify-Retry-Invalid-Session-Request` and
the admin client retries exactly once with a fresh token. A revoked offline
token or a genuine scope shortfall answers 403 with
`X-Shopify-API-Request-Failure-Reauthorize-Url`, and the client opens that URL
in the **top** frame — Shopify's consent screen sends `frame-ancestors 'none'`,
so an in-iframe redirect renders a blank panel with nothing in the console.

### Webhooks

`/api/webhooks` is mounted before the JSON body parser, because the HMAC covers
the exact bytes Shopify sent and a JSON round trip changes key order and unicode
escaping. Verification failure is the only case that answers non-2xx.

A *handler* failure still returns 200. Shopify's retry cannot fix a bug in the
handler, and repeated 5xx eventually gets the subscription disabled — which is
far worse than one unprocessed event. Failures are recorded on the `WebhookEvent`
row and replayed with `webhooks/service.replay(topic)`.

Topics whose processors belong to later phases (`orders/*`, `refunds/create`)
are still received, verified and stored with their full payload, marked
`SKIPPED`. When those phases land the backlog is replayable rather than lost.

---

## Storefront

The theme app extension in `extensions/codflow-theme` has two entry points: an
**app embed block** (global, publishes page context and loads the runtime) and
an **app block** (merchant-placed, marks where a button goes).

Configuration is split along one line, and duplicating a value across it is how
the two drift apart:

| Source | Provides |
|---|---|
| Liquid, via the app embed | What Shopify already knows: shop domain, currency, money format, locale, page type, product in view, cart totals. Free — no request, no layout shift. |
| CodFlow API | What the merchant configured: button labels, colours, placements, COD fees. Fetched once, cached in `sessionStorage`. |

Button appearance lives **only** in the CodFlow admin. The theme editor decides
*where* a button goes and how it spaces against the surrounding section — never
what it looks like — so a merchant has one place to restyle every placement.

### Transport: app proxy, not CORS

Theme app extension assets are served verbatim and **Liquid is not rendered in
`assets/`**, so a static JS file cannot be told the app's hostname. The runtime
therefore calls `https://<shop-domain>/apps/codflow/config`, which Shopify
forwards to `/api/proxy`. That is same-origin from the browser, so it works
unchanged on a merchant's custom domain, and Shopify signs every forwarded
request — `middlewares/verifyAppProxy.ts` verifies the signature and rejects
anything older than 90 seconds.

`/api/storefront` exposes the same controllers over open CORS for consumers that
cannot use the proxy (a headless storefront). It is credential-free, and must
stay that way: an open origin plus credentials is the classic CORS hole.

### Failure posture

The storefront runtime never breaks a store. Every failure path ends with the
theme's native buy buttons visible and working — a config request that fails, a
shop with no offline session, an invalid merchant CSS selector. Native buttons
are hidden only *after* a COD button has actually painted, because hiding Add to
Cart and then failing to render a replacement takes the store offline.

Caching is layered: Redis for 5 minutes server-side (tag-invalidated per shop,
so an uninstall stops COD immediately), `stale-while-revalidate` for shared
caches, an `ETag` for 304s, and `sessionStorage` in the browser.

---

## The COD form

### One validation engine, three consumers

`packages/shared/src/validation/` is imported by the admin builder's live
preview, the storefront renderer, and the API. Not three implementations of the
same rules — the same functions.

That is why the storefront asset has a build step. Theme extension assets are
served verbatim, so `extensions/codflow-theme/build.mjs` bundles the shared
engine into `assets/codflow-form.js`. The alternative — hand-writing a second
validator in vanilla JS — eventually disagrees with the server, and the symptom
is a shopper who passes every check in front of them and is then rejected with
no way to see why.

The rule that makes conditional forms work: **a field hidden by a condition is
not validated.** Validating hidden fields is the classic bug — the shopper is
told a field is required while looking at a form that does not contain it.
Visibility resolves to a fixed point (a field whose controller is hidden is
hidden too) with an iteration bound, so a circular rule a merchant can author in
the builder cannot hang a shopper's browser.

### Prices never come from the browser

The submission carries variant ids and quantities. It carries **no price
field**, and the DTO has no place to put one. Every amount is resolved from the
Shopify Admin API in `modules/orders/pricing.ts` immediately before the order is
written, then recomputed from the merchant's own COD fee and shipping rules.

Trusting a posted price is how COD apps get exploited: the shopper edits the
value in devtools and takes delivery at a price the merchant never set — and
because COD is paid on arrival, the merchant finds out when the courier hands
over the package.

Arithmetic uses `Prisma.Decimal`, and the currency's own precision. Scaling by
100 would mis-price JPY (no decimal places) and KWD (three).

### Submission pipeline

Ordered cheapest-first, because the endpoint is public and an attacker controls
how often it is called:

```
1. form token       signed, expiring; proves a real render preceded this
2. bot signals      honeypot + fill duration, read from the signed token
3. shop and form    two indexed reads
4. field validation the shared engine
5. phone            libphonenumber, per-country
6. duplicate check  one indexed read — a double-tap returns the first order
7. pricing          the only Shopify round trip
8. persist
9. enqueue          hand off to the worker; never blocks the response
```

Putting pricing before validation would mean a script posting garbage still
costs the merchant a Shopify API call per attempt, against a rate limit shared
with every other app on their store.

### Reaching Shopify

The shopper's receipt is the CodFlow reference, issued synchronously. The
Shopify order arrives moments later, written by the worker — a shopper should
not watch a spinner while the app negotiates with an API they have no
relationship with, and a push that fails deserves retries with backoff, which
you cannot offer inside a request that already returned.

**Draft order, not `orderCreate`.** `draftOrderCreate` + `draftOrderComplete`
has been stable for years, and `paymentPending: true` produces exactly COD
semantics — a real order, financial status `pending`, nothing captured.
`orderCreate` is one call instead of two, but its input type has moved across
recent API versions and a mismatch surfaces at runtime rather than at compile
time. The two-call path also models the merchant's own choice:
`createAsDraftOrder` decides whether the draft is completed automatically or
left for review.

Idempotency is layered, because pushing twice means one customer receiving two
deliveries:

| Layer | Mechanism |
|---|---|
| Queue | job id is `push:<orderId>`; BullMQ treats a duplicate as a no-op |
| Gates | refuse any order that already carries a `shopifyOrderGid` |
| Draft id | persisted the moment it exists, so a crash between create and complete resumes at complete |

**Gates** (`modules/orders/gates.ts`) are the seam where later phases attach.
They *read* `riskAction` and `otpVerified` off the order; they never compute
them. So the fraud engine and OTP flow land by populating columns that already
exist, without reaching into the push path. A `HOLD` order is not enqueued at
all — it would burn retry attempts against a condition the queue cannot clear —
and is enqueued later by whatever resolves the hold.

Terminal `FAILED` is written only once BullMQ exhausts its attempts, in the
job's `failed` handler. Setting it inside the processor would flag orders that
were about to succeed on their next try.

Recovery lives at `GET /api/admin/orders/stuck`,
`GET /api/admin/orders/:reference/push-status` and
`POST /api/admin/orders/:reference/retry-push`.

---

## Pixels

Server-side tracking is not an optimisation here, it is the only thing that
works: **a COD order completes outside the browser.** The shopper submits the
form and closes the tab; the order is confirmed, pushed to Shopify and delivered
days later. A browser pixel observes none of that, so the Purchase event has to
come from the server or it never fires.

Six providers — Meta, TikTok, Google Ads, Snapchat, Pinterest and a signed
webhook for anything else. Each translates one neutral event; adding a provider
is a file and a line in the registry.

### Deduplication is the whole problem

When a browser event and a server event describe the same action, the provider
must be able to tell. `pixelEventId(reference, eventName)` is deterministic and
computed identically on both sides, so the platform keeps one.

A random id would double-count every conversion — and that failure is silent and
expensive: the campaign appears twice as efficient as it is, and the merchant's
budget follows. Three layers guard it: the queue deduplicates by job id, the
dispatcher checks `alreadyDispatched` per pixel, and the provider dedupes on
`event_id`.

### Normalization is the whole feature

Advanced matching hashes personal details with SHA-256 so a platform can
recognise someone it already knows without CodFlow handing over a phone number.

A normalization bug does not throw. It produces a valid hash that matches
nobody, and match quality sits at zero with nothing in any log to explain it.
The rules that cost attribution when they drift:

| Field | Rule | Cost of getting it wrong |
|---|---|---|
| Phone | digits only, no `+` | Passing E.164 straight through is the most common mistake — match rate drops to zero |
| Name | lowercase, accents stripped, punctuation removed | `O'Brien` and `o brien` stop being one person |
| US ZIP | first five digits | Truncating a UK postcode matches the wrong area |
| Absent fields | stay `null` | `sha256("")` is a valid hash that never matches, and sending it makes quality *worse* |

Meta's `fbp`, `fbc`, IP and user agent are forwarded **unhashed** — they are
Meta's own identifiers, and hashing them breaks matching without any error.

### Gates, in order

Consent first: firing a marketing event for a shopper who declined is a privacy
violation and an app-listing risk. Recorded as `SKIPPED_CONSENT` so a merchant
seeing a low event count learns why rather than assuming a broken integration.

`SKIPPED` was added to `PixelDispatchStatus` for the same reason — an event the
app correctly declined to send is not a failure, and counting it as one would
bury real problems in a merchant's failure count.

Purchase fires from the **push**, not from submission. A COD order that fails to
reach Shopify is not a sale, and reporting one teaches the ad platform to bid on
conversions that never happened.

### What Google Ads actually is

Narrower than the others, and the admin says so. The Google Ads API and enhanced
conversions both need OAuth plus a Google-approved developer token, which is not
something a merchant can paste into a form. What *is* reachable with the
identifiers they have is the GA4 Measurement Protocol, with the conversion
imported into Ads from there. The Measurement Protocol also validates nothing on
its production endpoint, so a success means "Google accepted the request", not
"the conversion will appear" — and the result message says exactly that.

---

## Fraud engine

COD is the only checkout where the merchant ships first and finds out
afterwards, so a wrong decision is asymmetric: a missed fraudster costs one
parcel, but a blocked real customer costs the sale *and* tells them they look
like a criminal. Every default leans toward letting the order through and
flagging it.

### Signals, not verdicts

Detectors report what they observed; only `engine.ts` decides what it means.
Weights are additive points on a 0–100 scale, and no inferred signal reaches the
default high threshold of 60 alone. The low ones are as deliberate as the high:

| Signal | Weight | Why |
|---|---|---|
| `BLACKLISTED_*` | 100 | Not an inference — the merchant looked at it and decided |
| `IP_IS_TOR` | 60 | No ordinary reason to place a COD order over Tor |
| `FAKE_PHONE` | 45 | The courier cannot deliver to a number that does not exist |
| `DUPLICATE_PHONE` | 18 | Families share phones; customers reorder |
| `NO_EMAIL` | 4 | Plenty of COD shoppers simply do not have one |

A whitelist entry contributes **−1000**, so trust is expressed in the same
currency as suspicion and still appears in the breakdown — the merchant can see
*why* a risky-looking order was allowed.

### It fails open, always

Every internal failure — dead database, hung provider, malformed merchant rule,
exceeded deadline — resolves to `ALLOW` with the reason recorded on the
assessment. A fraud engine that fails closed converts its own outage into a
total checkout outage, which for a COD merchant is a far larger loss than the
fraud it exists to catch.

The engine is bounded by a 4-second deadline, `runDetectors` uses
`allSettled` so one failing detector does not discard the other six, and IP
intelligence has its own 2.5-second timeout on top.

The one thing that cannot be weakened: a blacklist hit blocks regardless of any
rule or threshold setting trying to allow it.

### Where it runs

After pricing (merchant rules can test `total`) and before persistence (a
`BLOCK` must not leave an order row behind). The verdict is written onto the
order *at creation*, not by a follow-up update — otherwise a push job firing in
that window would send a high-risk order to Shopify carrying the schema default
of `ALLOW`.

`REVIEW` deliberately produces a `CONFIRMED` order: the customer's part is
finished and telling them otherwise would be wrong. It is the Phase 4.5 push
gate, reading `riskAction`, that holds it back from Shopify until the merchant
decides.

Auto-blacklisting after repeated failed deliveries is **off by default**. A
customer whose parcels were lost by a courier looks identical to one who refuses
them.

---

## Google Sheets

Setup is three ordered steps — connect an account, choose a sheet, map the
columns — and the order is enforced by the API, not only by the UI.

**`drive.file`, not `drive`.** The app can only see spreadsheets it created or
that the merchant explicitly picked. Broader Drive scopes are "restricted" and
drag the app into Google's annual third-party security assessment — a real cost
for a feature that writes to one spreadsheet. The trade is that merchants cannot
browse their whole Drive, and the UI says so rather than showing an unexplained
short list.

**Three OAuth parameters that must all be present**, or the connection works
today and dies next week:

| Parameter | Without it |
|---|---|
| `access_type=offline` | no refresh token; sync stops when the first access token expires in an hour |
| `prompt=consent` | Google issues a refresh token only on the *first* authorization — a reconnect silently returns none |
| signed `state` | the callback cannot tell which shop it belongs to, so anyone could attach their Google account to someone else's shop |

The callback is public by necessity — the merchant's browser arrives from
accounts.google.com with no App Bridge session — so the signed, time-limited
`state` is its only protection. Refresh tokens are AES-256-GCM encrypted at the
repository layer, so no code path can write one in the clear.

### Row layout

Two merchant choices, and they interact:

- **One row per order** (default) joins line-item values into a single cell.
  A merchant reading the sheet as a fulfilment list wants this — without it a
  three-item order looks like three orders and their daily count is wrong.
- **One row per line item** repeats the customer on every row. Order-level
  money appears on the **first row only**; repeating the total would make a
  `SUM` over that column report three times the revenue.

Phone numbers and postal codes are written with a leading apostrophe so Sheets
keeps them as text. Otherwise `0712345678` loses its leading zero and `+91…` is
parsed as a formula — on a COD order that is the difference between a delivery
and a return.

### Failure taxonomy

The sync engine's retry decisions depend on classifying Google's errors, not on
a blanket retry:

| Class | Response |
|---|---|
| 429, 5xx, network | rethrow — BullMQ retries with backoff; Google's quota clears on its own |
| 404, 403 (sheet deleted or un-shared) | record, deactivate, **do not retry** — it fails identically forever |
| revoked grant | same, plus the admin prompts a reconnect |

Deactivating on a terminal failure is what stops one deleted spreadsheet from
generating thousands of doomed Google calls across a backlog.

The sheet worker runs at concurrency 3 rather than the default: Google allows
roughly 60 writes per minute per user, and spending that in seconds puts the
whole backlog into backoff — slower overall than pacing it.

---

## Data model

`Shop` is the tenant root — nearly every table carries `shopId` with
`onDelete: Cascade`, so an uninstall is a single delete. The full schema is in
[apps/api/prisma/schema.prisma](apps/api/prisma/schema.prisma). Notable groups:

- **Session** — shape dictated by the session storage package. Do not rename fields.
- **FormConfig / FormField** — the drag-and-drop builder. `position` uses gaps of
  10 so reordering doesn't rewrite every sibling. `isSystem` fields can be
  relabelled but not deleted; the order pipeline reads them by `key`.
- **CodOrder** — exists *before* a Shopify order does, which is why it has its own
  status enum. Risk score and level are denormalized onto the row for fast
  filtering; the full breakdown lives in `RiskAssessment.signals`.
- **RiskAssessment** — one row per scoring run, retaining the enrichment snapshot
  so a decision stays auditable even after a provider changes its answer.
- **DailyStat** — pre-aggregated per shop per day, so dashboard queries are
  `O(days)` rather than a scan over `cod_orders`.

Secrets at rest — Google refresh tokens, pixel CAPI tokens, OTP provider
credentials — are stored in `*Enc` columns, AES-256-GCM encrypted at the
repository layer with `ENCRYPTION_KEY`. They are never returned to the client.

---

## Local setup

Requires Node 20.19+ and Docker.

```bash
# 1. Dependencies
npm install

# npm 11 blocks lifecycle scripts; Prisma needs its postinstall for the engine
npm approve-scripts prisma @prisma/client @prisma/engines esbuild msgpackr-extract

# 2. Environment
cp .env.example .env
#    Fill in SHOPIFY_API_KEY / SHOPIFY_API_SECRET from the Partner Dashboard.
#    Generate the two secrets:
#      openssl rand -base64 32   -> ENCRYPTION_KEY
#      openssl rand -hex 64      -> SESSION_SECRET

# 3. Postgres + Redis
docker compose up -d

# 4. Database
npm run prisma:migrate
npm run prisma:seed

# 5. Check the setup before running anything
npm run preflight

# 6. Run — the Shopify CLI owns the HTTPS tunnel and injects app credentials
npm run dev
```

`shopify app dev` reads a `shopify.web.toml` in each of `apps/api` (the
`backend` role) and `apps/admin` (`frontend`), starts both, and points one
tunnel at the frontend. Vite proxies `/api` through to the backend, which is
what makes hot reload work inside the Shopify admin iframe — the browser talks
to a single origin and the HMR websocket rides the same tunnel.

The CLI injects its own environment into those processes and uses two names
this app does not: `SHOPIFY_APP_URL` for the tunnel it just created, and
`SCOPES`. `withShopifyCliEnv` in `config/env.ts` maps them, and lets the CLI's
value win — the tunnel hostname changes on every run, so a stale `APP_URL` left
in `.env` would build OAuth redirects that Shopify rejects.

**Using your own tunnel instead** is supported and is the better choice for
testing over several days, because the URL stops changing. Set
`automatically_update_urls_on_dev = false` in `shopify.app.toml`, point
`application_url`, the redirect URLs, `[app_proxy].url` and `.env`'s `APP_URL`
at your stable hostname, and run the processes yourself (`npm run dev:api`,
`npm run dev:worker`, `npm run dev:admin`). What must never differ is those
URLs and `APP_URL`: a mismatch fails OAuth with an error that names neither.

See [DEPLOYMENT.md](DEPLOYMENT.md) for installing on a development store.

---

## Tests

```bash
npm run test            # every workspace, plus the theme extension
npm run test:extension  # the extension alone (it is not an npm workspace)
npm run test:watch      # the API suite, in watch mode
```

**No external services required.** Everything under test is pure logic, or
resolves before a data-layer call, or runs against an embedded database.
Connections to the real Postgres and Redis retry in the background and the tests
that touch them expect the failure. That is deliberate: a suite needing
infrastructure is a suite people stop running.

The theme extension is tested through a root-level config rather than as a
workspace, because a theme app extension directory must not contain a
`package.json` — the Shopify CLI walks that directory when building the
extension and an unexpected manifest changes how it is treated.

### Migrations are verified, not assumed

`src/tests/migrations.test.ts` applies every migration, in order, to a real
PostgreSQL 18 instance via PGlite — Postgres compiled to WASM, so the SQL is
parsed and executed by the same engine that runs in production.

This matters because the initial migration was generated offline with
`prisma migrate diff` and the sheet-layout migration was written by hand, and
neither had ever touched a database. "Prisma generated it, so it is valid" is an
assumption whose cost, if wrong, is a release command that fails after the image
is already rolling out.

Beyond applying cleanly, the suite asserts the things a hand-written migration
gets wrong: cascade rules from `Shop` (which `shop/redact` depends on entirely),
the unique constraint on `WebhookEvent.shopifyWebhookId` (which makes webhook
delivery effectively-once), numeric rather than floating-point money columns,
and column-level parity against the Prisma schema in both directions — a field
with no column, and a column no field declares.

Coverage is weighted by blast radius rather than by line count:

| Area | Why it is tested here |
|---|---|
| Shared validation engine | The same functions run in the storefront, the admin preview and the API. A regression breaks the agreement between all three. |
| Pricing | Every amount a courier collects in cash. Covers currency precision — JPY has no decimals, KWD has three — and the fee-ordering rule. |
| Push gates | The seam Phases 6–9 attach to. Pins the precedence so a cancelled order never reports as "awaiting verification". |
| Sheet row builder | The no-double-count rule: order money on the first row only, or a `SUM` reports a multiple of real revenue. |
| Crypto, form tokens, OAuth state | Tamper detection, not just round-tripping. |
| Admin HTTP surface | Every `/api/admin/*` path is asserted to reject an unauthenticated caller, so a route that ships without the gate fails here. |
| Storefront HTTP surface | Adversarial: forged signatures, stale timestamps, path traversal, and the property that a client-supplied `price` is discarded. |
| Storefront form renderer | Label/control pairing, `aria-describedby` targets that exist before an error does, and that a merchant label containing markup renders as text. |
| Column mapper | That one field cannot occupy two columns, and that a header the merchant typed survives a field change. |

`vitest.config.ts` sets the environment through `test.env` rather than a setup
file, because `config/env` validates and freezes at module load — a setup file
assigning `process.env` would race the first import and fail intermittently.

### Useful commands

```bash
npm run typecheck          # every workspace
npm run test               # vitest
npm run prisma:studio      # browse the database
npm run build              # shared -> api -> admin, in dependency order
npm run shopify:deploy     # push extensions + config to Shopify
```

---

## Deployment

`Dockerfile` builds a three-stage production image on Debian slim (not Alpine —
Prisma's prebuilt engines target glibc/OpenSSL 3; musl needs an explicit
`binaryTargets` and is a common source of engine-not-found failures at boot).

Release command must run migrations before the new revision takes traffic:

```bash
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
```

Run the API and the BullMQ worker as separate processes:

```
web:    node apps/api/dist/server.js
worker: node apps/api/dist/queue/worker.js
```

---

## Build phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Architecture, folder structure, dependencies, database schema | **Complete** |
| 2 | Shopify OAuth, managed installation, token exchange, sessions | **Complete** |
| 3 | Theme app extension — COD button, app embed | **Complete** |
| 4 | COD form builder — dynamic fields, conditional logic, validation | **Complete** |
| 4.5 | Order push — BullMQ worker, draft-order pipeline, risk/OTP gates | **Complete** |
| 5 | Google Sheets — OAuth, column mapping, sync engine | **Complete** |
| 6 | Pixels — Meta, TikTok, Google Ads, server-side events | **Complete** |
| 7 | Fraud detection engine | **Complete** |
| 8 | Analytics dashboard | Pending |
| 9 | Billing — Shopify App Pricing + usage enforcement | Pending |
| 10 | Testing | **Complete** |
| 11 | Deployment | Pending |
