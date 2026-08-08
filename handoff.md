# CODkar — handoff

Orientation for picking this project up cold. [README.md](README.md) explains
*why* the architecture is what it is; this file explains *where things are*,
*what is proven*, and *what to do next*.

---

## Current state

The app is **deployed and installed**. It runs at `https://app.codflow.in` on
Render, and is installed on the development store `codkar-th9dk7h6`.

**It works end to end.** On 8 Aug 2026 a real cash-on-delivery order was placed
through the storefront, priced against Shopify, written to Shopify as a
completed order, and synced to Google Sheets. That is the first time the whole
path has run in production, and it closes the 403 that blocked everything —
see [The blocker, solved](#the-blocker-solved).

The dashboard now reads **INR** and the store *name*, which is the proof: those
fields fall back to USD and the store *domain* when the `shop` metadata query
fails, and that fallback is what the failure looked like for weeks.

Typecheck and build clean. 1,068 tests, no external services required.

```
packages/shared    93 tests
apps/admin        161 tests
apps/api          750 tests
extensions         64 tests
```

| | |
|---|---|
| Host | Render — `codflow-web`, `codflow-worker`, Postgres 17, Valkey 8 |
| Domain | `app.codflow.in`, TLS issued |
| Repo | `github.com/PSuraj1/codflow`, branch `main` |
| Shopify app | handle `codflow-codkar`, client id `359bf08a92b05ac7053cb08e645045d3` |
| Distribution | **Public** |
| Migrations | 8, applied to the hosted database |

**The product is called CODkar; almost every identifier still says `codflow`.**
That divergence is deliberate, not drift. The rename on 8 Aug 2026 changed only
what a merchant reads — the app name, admin copy, theme-editor strings, emails
and legal pages. Everything a rename would have broken kept its name: the app
handle (`SHOPIFY_APP_HANDLE` must match it), the app-proxy subpath (`codflow`,
which deployed storefront assets call), the domain, `@codflow/*` packages,
`codflow.js`/`codflow.css`, the `.codflow-*` CSS prefix, `codflow:*` DOM events,
`X-CodFlow-*` headers, the `CodFlow*` GraphQL operation names and JS globals,
and the Render and database names. Renaming any of those is a separate,
riskier job — see [Traps](#traps).

---

## The blocker, solved

Kept because the shape of this failure is worth recognising again, and because
the fix is now load-bearing.

**The symptom.** Every Admin API call returned `403 Forbidden` with an empty
body — including queries touching no customer data at all. A `ProductVariant`
lookup failed, and so did the `shop` metadata query. Two consequences looked
like separate bugs: orders failed because `resolveLineItems` could not price the
cart, and the phone field demanded `+91` because `shop.countryCode` was null, so
`libphonenumber-js` had no country to parse a bare ten-digit number against.

**The cause was one missing argument.** `shopify.auth.tokenExchange` takes
`expiring?: boolean` and sends `expiring: '0'` when it is absent, so every
exchange this app ever performed explicitly asked for a *permanent* offline
token — which Shopify no longer accepts on calls. The app installed cleanly and
then failed everything. Nothing re-exchanged it either: `resolveSession` only
re-exchanged on a missing token or narrowed scopes, never on age or rejection.

**Why it was hard to find.** Nothing in this repository says "permanent", and
the failure surfaces as a bare 403 with no body — which reads as a scopes
problem. The evidence was in the *Partner dashboard* under Monitoring → API
health, which reported *"Deprecated offline token use detected"* and stated that
deprecated tokens *"can't be used to make calls and must be exchanged for new
offline tokens."* No log this app writes would have told you.

**The fix, and the proof.** The exchange now passes `expiring: true`;
`shopify/tokenRefresh.ts` migrates an existing permanent token via
`migrateToExpiringToken` — no reinstall, no merchant interaction — and refreshes
before use. On deploy the worker logged *"Migrated to an expiring offline access
token"* for `codkar-th9dk7h6`, and a real COD order followed the same day.

**A theory that was wrong, recorded so it is not repeated.** This was first read
as Public distribution removing the in-development allowance while the protected
customer data request sat in `Draft`, with the conclusion that nothing in this
repository could fix it and only a Partner support ticket would help. That was
wrong on both counts. Two things should have raised doubt earlier: the Partner
page still stated *"You can access your selected data in development without
submitting for review"*, and the App Store review checklist marked the request
**complete**. Shopify's error id from the original failure, for the record, was
`62d3e4ef-1e10-496a-8f91-edb7e37022ed-1786074679`.

---

## Verify it still works

```bash
npm run preflight   # is this machine configured to run the app at all?
npm run typecheck   # builds @codflow/shared first, then every workspace
npm run test        # every workspace + the theme extension
npm run build       # shared -> api -> admin -> extension bundles
```

Those are what CI runs, plus `npm run check:bindings` and a Docker build — so a
green local run is *nearly* a green CI run. The gap is deliberate and is
covered under [Traps](#traps): CI catches things a Windows machine structurally
cannot.

**`npm run dev` does not start the worker.** `shopify app dev` runs only the web
process. Without `npm run dev:worker` in a second terminal, every order stops at
`CONFIRMED` and nothing reaches Shopify, Sheets or any pixel — silently.

Two diagnostics exist for the questions that otherwise take a day:

- `npm run preflight` — is `.env` even being read, do Postgres and Redis answer,
  are migrations applied, will Redis evict BullMQ's jobs, do `SHOPIFY_API_KEY`
  and `APP_URL` agree with `shopify.app.toml`.
- `npm run diagnose:theme -- <shop>` — is the app embed enabled, **on which
  theme**, or merely added-and-disabled.

---

## Layout

```
packages/shared/          Contracts + the validation engine. Imported by all three.
  src/contracts/          common, auth, storefront, forms, buttons, orders,
                          branding, fees, transfer, upsells, visibility, sheets,
                          fraud, pixels, analytics, billing, postal
  src/validation/         The SAME code the storefront, admin preview and API run

apps/api/                 Express 5, Prisma 6, BullMQ
  src/config/env.ts       Zod-validated env; refuses to boot on a bad one
  src/lib/                crypto, phone, shopTime, postal, orderToken,
                          planExemption, loadDotenv
  src/scripts/            preflight, diagnoseTheme
  src/shopify/            API client, GraphQL wrapper, topics, mutations, queries
  src/modules/<feature>/  routes -> controller -> service -> repository -> dto
  src/queue/, src/jobs/   BullMQ queues and their processors
  prisma/migrations/      8 migrations, applied against Postgres 17

apps/admin/               React 18, Polaris 13, App Bridge 4, Vite 8
  src/components/charts/  Hand-rolled SVG — validated palette, no chart dependency

theme-src/                Bundle sources, deliberately OUTSIDE the extension —
  src/form.ts             which may only contain assets/, blocks/, locales/,
  src/pixels.ts           snippets/. Emits into the extension's assets/.

extensions/codflow-theme/ Theme app extension (assets, blocks, locales only)

scripts/                  check-linux-bindings.mjs — see Traps
```

Deployment lives at the root: `Dockerfile`, `railway.json`, `render.yaml`,
`.github/workflows/ci.yml`, and [DEPLOYMENT.md](DEPLOYMENT.md) — the runbook,
including a section written for this app's actual production run.

**The layering rule:** controllers never import Prisma; repositories never
import Express.

---

## Decisions already made — do not re-litigate

| Decision | Why |
|---|---|
| Prisma 6, not 7 | `shopify-app-session-storage-prisma@9` peer-depends on it |
| React 18, not 19 | Polaris 13 peer-depends on it; do **not** use `--legacy-peer-deps` |
| API version pinned `2026-07` | No `latest` alias; a retired version silently falls forward |
| App Bridge from CDN, never bundled | A vendored copy goes stale and breaks silently |
| `draftOrderCreate` + `draftOrderComplete` | Verified working. `paymentPending: true` *is* COD |
| App proxy, not direct CORS | Theme assets can't render Liquid, so can't learn the app's hostname |
| **XHR, not `fetch`, in storefront code** | Shopify wraps `window.fetch` and it intermittently never settles |
| `drive.file`, not `drive` | Broader scopes trigger Google's annual security assessment |
| Fraud engine fails **open** | A closed-failing engine turns its own outage into a checkout outage |
| Prices never come from the browser | The DTO has no price field; every amount re-resolved server-side |
| Postal lookup server-side + cached | The shopper's browser never talks to a third party |
| Both halves send Purchase; provider dedupes | `pixelEventId()` is identical on both sides |
| **Public distribution, not Custom** | Custom locks an app to one store permanently and forfeits the App Store |
| Plan exemption is **env, not a column** | A row is lost when the database is rebuilt, and writable by any admin session |

---

## Traps

Things that cost real time. The ones marked **CI** are failures a Windows
machine structurally cannot reproduce.

**CI — npm records only the platform's own native bindings.** npm writes the
optional dependency matching the machine that generated the lockfile
(npm/cli#4828). This lockfile is written on Windows, so every package shipping
native bindings silently omits the Linux one and `npm ci` on Linux installs
nothing to replace it. It never fails at install; it fails much later inside a
build step, naming a `.node` file rather than the lockfile that omitted it. It
cost two CI runs and a production deploy — once for `rolldown`, once for
`lightningcss`. The fix each time is declaring the binding in
`optionalDependencies`; it stays optional and carries `os`/`cpu`, so Windows
installs skip it. `npm run check:bindings` now fails the build when one is
missing, and runs in CI.

**CI — `typecheck` and `test` used to need a prior build.** `@codflow/shared`
resolves through its `exports` to `dist/`, which is gitignored. Both commands
passed locally only because a stale `dist` was lying around. `typecheck` now
builds shared first, and the API's vitest config aliases `@codflow/shared` to
its *source* — which is what `apps/admin` always did. To reproduce a clean
checkout locally you must delete `dist` **and** `tsconfig.tsbuildinfo`;
`tsc` treats the buildinfo as proof the output is current and skips emitting.

**`.dockerignore` excluded the legal pages.** `**/*.md` matched
`docs/legal/*.md`, which the app reads from disk at request time — so `COPY
docs/legal` copied an empty directory and every `/legal/*` URL 404'd in
production while working in development. Exactly the failure
`modules/legal/controller.ts` documents. A negation keeps the four served pages;
two CI steps assert they ship and render.

**Vite inlines build-time config, so Docker needs the ARG.** `SHOPIFY_API_KEY`
and `SUPPORT_TELEGRAM_URL` are baked into the admin bundle at build time. Nothing
passed them into the image, so the bundle shipped with an empty API key — App
Bridge fails to initialise and the admin renders a blank frame with nothing in
the console. Declared as build args in the Dockerfile.

**Never `top.location.assign()` from the embedded admin.** Reading any named
property from a cross-origin `Location` is blocked — navigating someone else's
frame is permitted, inspecting it is not. It throws on every embedded page view
and on none in local development. Use `navigateTop` in `lib/appBridge.ts`, which
prefers App Bridge and otherwise uses `window.open(url, '_top')`.

**BullMQ v5 rejects a job id containing `:`.** Every enqueue helper used
`push:<id>`, so `queue.add` threw on every call — and each helper deliberately
swallows its errors so a queue outage cannot fail a shopper's submission. Orders
saved, shoppers saw success, and *nothing* was ever pushed, synced, scored or
reported. `jobKey()` joins with hyphens; `queue/queues.test.ts` guards it.

**`tokenExchange` asks for a deprecated token unless told otherwise.** Its
`expiring` argument is optional and the library sends `expiring: '0'` when it is
missing — a permanent offline token, which Shopify refuses on every Admin API
call. The app installed cleanly and then failed every request, including
queries touching no customer data, which is what made it read as a scopes
problem. Two things make it hard to find: nothing in the app's own code says
"permanent", and the failure surfaces as a bare 403 with an empty body. The
evidence is in the Partner dashboard under Monitoring → API health, not in the
app's logs. **Expiring tokens live about an hour**, so anything holding a
session across time must refresh — `loadOfflineSession` does it for every
caller, and `graphql.ts` retries a 401 through the refresh token *before*
purging the session, because purging throws the refresh token away and strands
the worker until a merchant next opens the app. Public apps created on or after
1 Apr 2026 must use expiring tokens; every other public app must migrate by
1 Jan 2027.

**Shopify wraps `window.fetch` on every storefront.** The wrapper intermittently
never settles on app-proxy requests, with no error. All storefront requests use
`XMLHttpRequest` with explicit timeouts.

**`.env` is read from the repo root, not the cwd.** Every npm workspace script
runs with the cwd set to its own package. `lib/loadDotenv.ts` handles it — and
skips entirely under `NODE_ENV=test`, or tests read the developer's real values.

**A blank env var is not `undefined`.** `.env.example` ships optional keys empty
and `z.enum([...]).optional()` rejects `''`. `withoutBlankValues` collapses them.

**A theme app extension may only contain `assets`, `blocks`, `locales`,
`snippets`.** Hence `theme-src/` at the root — outside the workspace globs,
because a directory matched by those without a `package.json` breaks `npm ci`.

**The three GDPR topics are not subscriptions.** They belong under
`[webhooks.privacy_compliance]`, keyed by purpose.

**App handle must be globally unique.** `codflow` was taken; the app is
`codflow-codkar`. `SHOPIFY_APP_HANDLE` must match or the upgrade button 404s —
`render.yaml` had `codflow` and was wrong until it was deployed.

**App embeds are per-theme.** `shopify app dev` previews its own throwaway theme.
Use `diagnose:theme`.

**Shopify caches app-proxy responses.** A newly added proxy route can serve a
stale miss (HTML instead of JSON) for a while. Add a cache-busting param to test.

**esbuild does not typecheck.** `theme-src/tsconfig.json` exists solely so
`npm run typecheck` covers the bundle sources.

**Prisma array columns are nullable.** `String[]` becomes a nullable `text[]`
with a `'{}'` default while the client treats the field as required.

**A schema default only exists once a row does.** Install seeds four of the six
renderable `ButtonConfig` placements, so the customizer synthesizes the other
two — hence `DEFAULT_BUTTON_STYLE` in `shop/defaults.ts`. Change one and change
the other, or a merchant is shown one default and saves another.

**Polaris's `ContextualSaveBar` blanks the whole app.** It calls `useFrame()`,
which throws without a `<Frame>` ancestor — and an embedded app has none on
purpose. Use `components/SaveBar.tsx`. The same applies to anything Polaris
documents as Frame-dependent: `Toast`, `Loading`, `Modal`'s frame variant.

**React rejects `loading="true"` on a `<button>`.** It knows `loading` as an
enumerated attribute (`lazy`/`eager`) and logged *"Unexpected value for
attribute"* on every dirty form. App Bridge wants a bare boolean attribute, so
the empty string is both valid HTML and what it expects.

**An error boundary whose fallback needs a provider must live inside it.**
`main.tsx` orders them router → Polaris → boundary. A fallback that cannot
render converts every error into a silent blank screen.

**`prisma migrate dev` hangs when it cannot prompt.** Generate SQL with
`prisma migrate diff --from-schema-datasource … --script`, save it under
`prisma/migrations/<timestamp>_<name>/`, and apply with `migrate deploy`.

**Regenerating the Prisma client fails while the dev server runs.** `EPERM …
rename query_engine-windows.dll.node`. Stop `npm run dev` first — though the
TypeScript types are written *before* the rename fails, so a typecheck may
mislead you into thinking it succeeded.

**"The table `session` does not exist" means the database is down.**
`PrismaSessionStorage.pollForTable` retries for ~5 minutes then throws that
message — so the suite reports every test passing, takes 370s, and exits
non-zero. Run `npm run preflight` before believing anything else.

**An order's status does not tell you whether its push failed.** `CodOrderStatus`
only reaches `FAILED` on some paths. Anything triaging stuck orders has to read
`pushAttempts` — `OrdersPage.isFailing` does.

**`findStuck` and `liveCounters` must agree.** Both exclude `riskAction: BLOCK`.

**There are two postal-code mechanisms.** `allowedPostalPatterns` /
`blockedPostalPatterns` run at PIN entry; a `POSTAL_CODE` block-list entry scores
the order *after* submission. Both live on the fraud tab, which makes them easy
to confuse.

**The Vite dev server proxies only the prefixes it is told to.** `/api` and
`/legal` are configured; add the prefix when adding another root route.

**App Bridge's nav menu cannot nest.** Grouping is `components/SectionTabs.tsx`,
and every tab is a *route*, not component state. Adding a screen means adding it
to a section's tab list.

**Polaris `Tabs` cannot be clicked in jsdom.** Test the selection rule through
`tabIndexFor` instead. `Tabs` also needs a `ResizeObserver` stub.

**Polaris uses `aria-disabled`, not the native attribute.**

**Webhooks mount before `express.json`.** The HMAC covers exact bytes.

---

## Where the seams are

**Push gates** (`modules/orders/gates.ts`) *read* `riskAction` and `otpVerified`;
they never compute them. OTP lands the same way fraud did.

**The profiling opt-out rides on that seam and needs nothing else.** A shopper
who refuses automated decisions gets a `BLOCK` downgraded to `REVIEW` in
`fraud/engine.ts`, and a REVIEW order is already a CONFIRMED order the push
gates hold. Two things are deliberate: it is applied *after* the blacklist
override, making it the only thing that outranks a blacklist entry, and it
withdraws only the power to *refuse* — the order is still scored. The flag
arrives either as `input.profilingOptOut` or as a `CONSENT` form field keyed
`profilingOptOut`, OR'd together in `orders/service.ts`.

**Plan exemption is applied in four places** — `billing.effectivePlan`,
`shop/repository.findPlan`, the storefront config, and the session response the
admin renders. Miss one and the shop is gated as Enterprise while its badge says
Free. `withPlanExemption` takes a resolved plan and returns a plan, so a fifth
caller reads as "this, unless exempt".

**Token renewal has exactly one seam, and it is `loadOfflineSession`.** All
seven Admin API consumers — order push, the storefront config, billing, webhook
handlers, `diagnose:theme` — reach Shopify through it, so migrating a permanent
token and refreshing an expiring one both live there rather than at the call
sites. A new consumer inherits it by loading a session the normal way. Renewal
never throws: on failure the caller gets the session it would have got anyway,
so a Shopify outage cannot turn into a boot failure or a crashed job. The
worker additionally sweeps at boot (`migratePermanentTokens`) for shops nothing
has touched yet.

**Queues** — eight declared, six with processors (`ORDER_PUSH`, `SHEET_SYNC`,
`FRAUD_SCAN`, `PIXEL_DISPATCH`, `STATS_REBUILD`, `DATA_RETENTION`).
`AUTOMATION` and `NOTIFICATION` are unused.

`DATA_RETENTION` is the only *scheduled* queue. `scheduleRetentionSweep()`
installs it from the worker on boot with `upsertJobScheduler`, which is
idempotent — `add({ repeat })` would leave a second scheduler behind on every
pattern change.

**Data retention** — `ShopSettings.orderRetentionDays` (365 default, no "off"
value) and `jobs/enforceRetention.ts`, which runs at 03:00 and clears personal
columns past the cutoff. It *blanks* rather than deletes, sharing the column
list with `customers/redact` through `shop/repository.REDACTION` — the two must
agree, because a field added to one and not the other survives a redaction.
`CodOrder.redactedAt` is both the record and the "already done" marker.

**Order bumps** are flat-priced add-ons, not Shopify products. The browser sends
ids only; every price is re-resolved from the database, scoped to the shop and
to `isEnabled`. They join the *total* but never the *subtotal* — so ticking one
cannot clear a merchant's minimum order value, inflate a percentage COD fee, or
earn free delivery. Each becomes its own custom line on the Shopify order, read
from the order's own snapshot so renaming a bump does not rewrite history.

**Settings transfer** (`modules/transfer`) selects columns explicitly, and that
is a security decision: `select` is an allow-list, so a column added later is
absent from the export until someone names it. Secrets and the fraud block list
(real shoppers' phone numbers) are omitted entirely. `dto.ts` is the import
boundary — an allow-list with the same bounds the admin screens enforce, so an
import cannot route around validation.

**`stats.record*`** is the only place a dashboard counter is incremented, and
nothing in it can throw at its caller.

**Webhooks** — all five order topics have processors. `webhooks/service.replay(topic)`
folds in deliveries stored before a processor existed.

**Postal providers** (`lib/postal.ts`) — one per country, currently India only.

**`FormConfig` carries more than the builder edits.** The wording is reachable
via the submit row. The layout and behaviour flags beside it — `layout`,
`showOrderSummary`, `showCouponField`, `showTermsCheckbox`, `termsUrl`,
`trackAbandonment`, `botProtection`, `minFillSeconds` — are accepted by
`UpdateFormSchema` and have no UI. **Only `layout`, `showOrderSummary` and
`showProductImage` are actually read by the storefront**; the rest are stored,
served and ignored. `botProtection` and `minFillSeconds` *are* enforced, via
`checkBotSignals` in `packages/shared`.

---

## Known gaps

### Unverified rather than broken

**Proven on 8 Aug 2026** — one real COD order, start to finish. It priced
against Shopify, reached Shopify as a completed order (`draftOrderCreate` +
`draftOrderComplete` in production, not just a local worker), and synced to
Google Sheets. Store health reports COD live on the storefront. *One* order is
not a load test, but the path is no longer hypothetical.

Still genuinely unverified:

- **The order-bump tick boxes and the form logo have never been seen
  rendering.** Both were built without a working storefront to check against.
  The storefront works now, so this is a five-minute check rather than a blocker.
- **The token refresh has never been observed.** Migration is proven; the
  hourly `refreshToken` path that follows it has only run against mocks. Look
  for *"Refreshed the offline access token"* in the worker log. If it is absent
  and the app is still working, something is re-exchanging instead — worth
  understanding, because the worker cannot re-exchange.
- **The retention sweep has never run against real rows.** Batching, the
  per-shop ceiling and continue-on-failure are covered by tests that mock the
  repository. For a job whose purpose is destroying data, watch it once.
- **No pixel has ever been configured against a real ad platform.**
  `POST /pixels/:id/test` is the fastest way to find out. The dashboard reports
  *Ad pixels: not set up* — this is now the largest unproven subsystem.
- **Google Sheets' consent screen is still in Testing**, which expires refresh
  tokens after 7 days. The sync works today; it will stop working roughly a week
  after the grant unless the screen is published.
- **Managed pricing plans do not exist** in the Partner Dashboard. Display names
  must match `PLAN_CATALOGUE` exactly — `Free`, `Starter`, `Pro`, `Enterprise` —
  at $0 / $9 / $18 / $26, with 3-day trials on Starter and Pro. Nothing in the
  code can read the dashboard's figures back, so a mismatch shows one price and
  bills another.

### Ungoverned settings

15 `ShopSettings` columns have no admin control and can only be changed by SQL:
`autoFulfill`, `markAsPaid`, `inventoryBehaviour`, `defaultOrderTags`,
`createAsDraftOrder`, `sendShopifyOrderConfirmation`, the five notification
fields, `forceRtl`, `currencyFormat`, `dateFormat`, and `orderRetentionDays`.

### Real work, ordered by value

1. **Merchant notifications are entirely dead.** `notifyOnNewOrder`,
   `notifyOnHighRisk`, `notifyOnSyncFailure` and `customerEmailEnabled` appear
   nowhere in `apps/api/src` outside tests. `NotificationTemplate` is only
   touched by seeding. The `NOTIFICATION` queue has no processor. `lib/mailer`
   has exactly one caller — the GDPR data-request handler. Templates seeded,
   columns present, mailer working, queue declared, and **no merchant is ever
   emailed about anything**. For a COD app that is the largest functional gap.
2. **Product eligibility is never enforced at submission.** `resolveEligibility`
   runs only in the storefront config path and returns `true` unconditionally
   when there is no product in view. `orders/service.ts` contains no eligibility
   check at all, so a crafted POST can order an excluded product. The button not
   rendering is the only thing preventing it.
3. **Fill in the legal pages before submitting to the App Store.** 52 `[PLACEHOLDER]`
   occurrences (20 distinct) across four documents, none reviewed by a lawyer.
   `docs/legal/README.md` has the detail. Also: `*controller*` and `*processor*`
   render as literal asterisks on the live privacy policy — the renderer does
   `**bold**` but not `*italic*`, and `markdown.test.ts` misses it.
4. **`COLLECTION_PAGE` and `HOME_PAGE` are enabled in the customizer and cannot
   render.** `codflow.js` auto-places only `PRODUCT_PAGE` and injects only
   `STICKY_MOBILE` and `FLOATING`; the rest need an app block, and a collection
   page has no product to order. A per-card implementation was built and
   reverted at the owner's request. Either build it properly or remove the
   placements.
5. **Bulk retry on the Orders screen.** 500 stuck orders is 500 clicks. Bound it
   per call the way `rescanPending` caps at 200, and enqueue rather than pushing
   inline. Each row also mounts its own `useRetryPush` *and* `useVerifyOrder`.
6. **Order detail — what the shopper actually typed.** Build it as a detail view
   fetched per order, not fields on the list: `StuckOrderSummary` omits personal
   data on purpose, and putting every address into a payload polled every
   fifteen seconds is how a support tool becomes a privacy incident.
   `repository.collectCustomerData` already assembles this shape.
7. **Fraud detectors have no direct tests** — the engine tests mock
   `runDetectors` wholesale.
8. **OTP** — model, gates, plan feature and meter exist. Nothing sends a code.
9. **`codflow.js` is 42 KB against Shopify's 10 KB app-block threshold.**
    Logged as an error on every deploy, not blocking. Will matter at review.
10. **`openInPopup` and `iconName`** are on `ButtonConfig`, honoured by nothing.

---

## Environment

Requires Node 20.19+ and Docker.

```bash
npm install
docker compose up -d          # Postgres 17 + Redis 7 (noeviction)
npm run prisma:migrate
npm run prisma:seed
npm run preflight

npm run dev                   # terminal 1 — CLI runs api + admin, owns the tunnel
npm run dev:worker            # terminal 2 — REQUIRED, see above
```

Copy `.env.example` to `.env`. Beyond the obvious:

- `SHOPIFY_APP_HANDLE` must equal `handle` in `shopify.app.toml`
  (`codflow-codkar`).
- `ENCRYPTION_KEY` is permanent — rotating it makes every stored Google refresh
  token undecryptable.
- `APP_URL` must match `application_url` **exactly**. A trailing slash fails the
  install with an error naming neither.
- `PLAN_EXEMPT_SHOPS` — comma-separated myshopify domains that ignore plan
  limits. Matches `Shop.domain`, so a **custom storefront domain never
  matches**; entries that cannot match are named in a warning at boot. Must be
  set on the worker too, which enforces limits independently.
- `SUPPORT_TELEGRAM_URL` is inlined into the admin bundle at *build* time, not
  read at runtime.

**`automatically_update_urls_on_dev` is now `false`.** `shopify app dev` can no
longer rewrite the four URLs in `shopify.app.toml` to a throwaway tunnel — which
is what keeps a dev session from repointing production at a hostname that dies
when the laptop sleeps. The cost is that local development no longer updates
them for you: use a stable tunnel, or put them back by hand for the session and
do not commit that.
