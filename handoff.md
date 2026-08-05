# CodFlow — handoff

Orientation for picking this project up cold. [README.md](README.md) explains
*why* the architecture is what it is; this file explains *where things are*,
*what is proven*, and *what to do next*.

---

## Current state

All 11 phases are built, and the critical path has now been **verified against a
live Shopify store**. Typecheck and build clean. 1,039 tests, no external
services required to run them.

```
packages/shared    93 tests
apps/admin        156 tests
apps/api          726 tests
extensions         64 tests
```

**There is no git repository.** `.github/workflows/ci.yml` exists and has never
run — no `.git`, no remote, no history. Everything below was verified by running
the commands locally. The first thing anyone should do is `git init`, push, and
let CI run: it builds the Docker image and asserts the container starts, which
is exactly the check that would have caught the Dockerfile bug in Traps.

**Test store:** `codkar-th9dk7h6.myshopify.com` · app handle `codflow-codkar` ·
client id `359bf08a92b05ac7053cb08e645045d3` · released version
`codflow-codkar-4`.

### Proven end to end on that store

Form → validation → fraud scan → order created → queued → worker →
`draftOrderCreate` → `draftOrderComplete` (`paymentPending: true`) →
`statusPageUrl` captured → shopper redirected to Shopify's own order page.

Order **#1002** (`CF-ZRCZFJ8UT`) came through with the PIN-derived address and an
E.164 phone intact. The draft-order mutation shapes — the largest unknown in this
codebase for most of its life — are confirmed on API version `2026-07`.

Also verified live: COD button auto-placement, the form dialog, PIN → city /
state / country autofill, and the fraud engine correctly holding a bad order
(`FAKE_PHONE`, score 45, `REVIEW`).

---

## Verify it still works

```bash
npm run preflight   # is this machine configured to run the app at all?
npm run typecheck   # every workspace + the theme extension
npm run test        # every workspace + the theme extension
npm run build       # shared -> api -> admin -> extension bundles
```

The last three are what CI runs (`.github/workflows/ci.yml`), so a green local
run means a green CI run.

**`npm run dev` does not start the worker.** `shopify app dev` runs only the web
process. Without `npm run dev:worker` in a second terminal, every order stops at
`CONFIRMED` and nothing reaches Shopify, Sheets or any pixel — silently. This
cost hours to discover; do not skip it.

Two diagnostics exist for the questions that otherwise take a day:

- `npm run preflight` — is `.env` even being read, do Postgres and Redis answer,
  are migrations applied, will Redis evict BullMQ's jobs, do `SHOPIFY_API_KEY`
  and `APP_URL` agree with `shopify.app.toml`.
- `npm run diagnose:theme -- <shop>` — is the app embed enabled, **on which
  theme**, or merely added-and-disabled. Reads `settings_data.json` through the
  Admin API.

---

## Layout

```
packages/shared/          Contracts + the validation engine. Imported by all three.
  src/contracts/          common, auth, storefront, forms, buttons, orders,
                          branding, visibility, sheets, fraud, pixels,
                          analytics, billing, postal
  src/countries.ts        ISO country list — the form's fallback when a merchant
                          never populated the country field
  src/validation/         The SAME code the storefront, admin preview and API run

apps/api/                 Express 5, Prisma 6, BullMQ
  src/config/env.ts       Zod-validated env; refuses to boot on a bad one
  src/lib/                crypto, phone, shopTime, postal, orderToken, loadDotenv
  src/scripts/            preflight, diagnoseTheme
  src/shopify/            API client, GraphQL wrapper, topics, mutations, queries
  src/modules/<feature>/  routes -> controller -> service -> repository -> dto
  src/queue/, src/jobs/   BullMQ queues and their processors
  prisma/migrations/      8 migrations, applied against real Postgres 17

apps/admin/               React 18, Polaris 13, App Bridge 4, Vite 8
  src/components/charts/  Hand-rolled SVG — validated palette, no chart dependency

theme-src/                Bundle sources, deliberately OUTSIDE the extension —
  src/form.ts             which may only contain assets/, blocks/, locales/,
  src/pixels.ts           snippets/. Emits into the extension's assets/.
  build.mjs

extensions/codflow-theme/ Theme app extension (assets, blocks, locales only)
```

Deployment lives at the root: `Dockerfile`, `railway.json`, `render.yaml`,
`.github/workflows/ci.yml`, and [DEPLOYMENT.md](DEPLOYMENT.md) — the runbook,
including the Partner Dashboard steps that cannot be done from code.

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
| `draftOrderCreate` + `draftOrderComplete` | **Verified working.** `paymentPending: true` *is* COD |
| App proxy, not direct CORS | Theme assets can't render Liquid, so can't learn the app's hostname |
| **XHR, not `fetch`, in storefront code** | Shopify wraps `window.fetch` and it intermittently never settles — see Traps |
| `drive.file`, not `drive` | Broader scopes trigger Google's annual security assessment |
| Fraud engine fails **open** | A closed-failing engine turns its own outage into a checkout outage |
| Prices never come from the browser | The DTO has no price field; every amount re-resolved from Shopify |
| Postal lookup server-side + cached | The shopper's browser never talks to a third party; one lookup serves every shop |
| Both halves send Purchase; provider dedupes | `pixelEventId()` is identical on both sides |
| No advanced matching in the browser | The server already sends those fields hashed |

---

## Traps

Things that cost real time. The first four were found only by running against a
live store.

**`npm ci --allow-scripts` fails the Docker build outright.** npm 11 rejects the
flag in a project-scoped install — *"--allow-scripts is not allowed in
project-scoped installs"* — so it errored rather than skipping a script, and the
image never built. It was not needed either: Prisma's postinstall only fetches
the query engine, the build stage already runs `prisma generate` explicitly, and
the runtime stage copies the generated client across. Both `npm ci` lines now
match CI's, which is the proven-good invocation. Found by building the image by
hand; CI would have caught it, but CI has never run.

**Building the image needs a working Debian mirror.** The `apt-get` layers fetch
from `deb.debian.org`, and on a slow or filtered connection they time out after
fifteen minutes with `Connection timed out`. That is the environment, not the
Dockerfile — it is the reason the image build is still unverified end to end
here. Build it in CI or on the host platform rather than debugging it locally.

**BullMQ v5 rejects a job id containing `:`.** Every enqueue helper used
`push:<id>`, so `queue.add` threw on every call — and each helper deliberately
swallows its errors so a queue outage cannot fail a shopper's submission. The
result: orders saved, shoppers saw success, and *nothing* was ever pushed,
synced, scored or reported. A correct fail-safe hiding a total outage. `jobKey()`
joins with hyphens; `queue/queues.test.ts` guards it.

**Shopify wraps `window.fetch` on every storefront.** The wrapper intermittently
never settles on app-proxy requests, with no error. It silently stopped the COD
button rendering and made the form show "could not load". All storefront requests
now use `XMLHttpRequest` with explicit timeouts.

**`.env` is read from the repo root, not the cwd.** Every npm workspace script
runs with the cwd set to its own package, so `dotenv/config` found nothing while
a filled `.env` sat two directories up. `lib/loadDotenv.ts` handles it — and
skips entirely under `NODE_ENV=test`, or tests read the developer's real values.

**A blank env var is not `undefined`.** `.env.example` ships optional keys empty
and `z.enum([...]).optional()` rejects `''`, so copying the template verbatim
failed to boot. `withoutBlankValues` collapses the two.

**A theme app extension may only contain `assets`, `blocks`, `locales`,
`snippets`.** A `src/` or `tsconfig.json` inside it fails `shopify app deploy`.
Hence `theme-src/` at the root — outside the `packages/*` and `apps/*` workspace
globs, because a directory matched by those without a `package.json` breaks
`npm ci`.

**The three GDPR topics are not subscriptions.** They belong under
`[webhooks.privacy_compliance]`, keyed by purpose. As `[[webhooks.subscriptions]]`
the deploy fails with "The following topic is invalid".

**Order webhooks need protected-customer-data approval** in the Partner Dashboard
before `deploy` will create a version. Nothing in the config is wrong when this
happens.

**App handle must be globally unique.** `codflow` was taken; the app is
`codflow-codkar`. `SHOPIFY_APP_HANDLE` must match or the upgrade button 404s.

**App embeds are per-theme.** `shopify app dev` previews its own throwaway theme;
enabling the embed on the live theme does nothing for it. Use `diagnose:theme`.

**Shopify caches app-proxy responses.** A newly added proxy route can serve a
stale miss (HTML instead of JSON) for a while. Add a cache-busting param to test.

**Every `t:` key in a block's `{% schema %}`** needs an entry in
`locales/en.default.schema.json`, or theme check errors during deploy.

**esbuild does not typecheck.** `theme-src/tsconfig.json` exists solely so
`npm run typecheck` covers the bundle sources.

**Test files leak into builds.** `apps/api/tsconfig.json` excludes `src/tests/**`
because the HTTP harness would otherwise ship a hardcoded secret in the image.

**Prisma array columns are nullable.** `String[]` becomes a nullable `text[]`
with a `'{}'` default while the client treats the field as required.

**A schema default only exists once a row does.** Install seeds four of the six
renderable `ButtonConfig` placements, so the customizer has to synthesize the
other two — hence `DEFAULT_BUTTON_STYLE` in `shop/defaults.ts`, which mirrors the
column defaults. Change one and change the other, or a merchant is shown one
default and saves another. Two consequences fall out of the same fact: an
unconfigured placement reports `isEnabled: false` rather than the column's
`true`, because no row renders nothing; and `buttons/service` writes the whole
merged record on every save, because the upsert's create branch would otherwise
take those column defaults and switch a placement on when the merchant only
changed a colour.

**Polaris's `ContextualSaveBar` blanks the whole app.** It calls `useFrame()`,
which throws without a `<Frame>` ancestor — and an embedded app has none on
purpose, because the admin renders that chrome outside the iframe. Every screen
used it, so going dirty on any form threw on the first keystroke. Use
`components/SaveBar.tsx`, which drives App Bridge's `<ui-save-bar>`. The same
applies to anything else Polaris documents as Frame-dependent: `Toast`, `Loading`,
`Modal`'s frame variant.

**An error boundary whose fallback needs a provider must live inside it.** The
above threw, the boundary caught it, and then the *fallback* threw
`MissingAppProviderError: No i18n was provided` because it renders Polaris and
sat outside `AppProvider` — so React tore the tree down and the merchant got a
blank iframe with the original error reported nowhere. `main.tsx` now orders
them router → Polaris → boundary. A fallback that cannot render is worse than no
boundary, because it converts every error into the same silent blank screen.

**The Google redirect URI lives in three places and one of them changes hourly.**
`.env`, Google Cloud's authorised redirect list, and — because it embeds the
tunnel hostname — a value that `shopify app dev` invalidates on every run. A
mismatch surfaces as `redirect_uri_mismatch` on Google's own page mid-OAuth,
saying nothing about tunnels. `preflight` compares it against the URL this run
actually serves; it stays quiet when the credentials are absent, because Sheets
is optional. A stable tunnel earns its keep here more than anywhere else.

**"The table `session` does not exist" means the database is down.** If Postgres
becomes unreachable while `npm run test` runs, `PrismaSessionStorage.pollForTable`
retries `prisma.session.count()` for about five minutes and then throws that
message — so the suite reports every test passing, takes 370s instead of 30s,
and exits non-zero on an unhandled rejection naming a table that is fine. The
`@@map("shopify_sessions")` on the model makes it look like a naming bug; it is
not, the poll goes through the Prisma accessor. Run `npm run preflight` before
believing anything else.

**`prisma migrate dev` hangs when it cannot prompt.** Run detached — from a
script, a background task, anything without a TTY — it waits forever on a
confirmation nobody can answer, and writes no migration. Generate the SQL with
`prisma migrate diff --from-url … --to-schema-datamodel … --script`, save it
under `prisma/migrations/<timestamp>_<name>/migration.sql`, and apply it with
`migrate deploy`, which never prompts and never resets. Read the diff before
applying it: `migrate dev` is also the command that offers to drop the database.

**Regenerating the Prisma client fails while the dev server runs.** `EPERM …
rename query_engine-windows.dll.node` means a node process has the engine
locked. Stop `npm run dev` first.

**An order's status does not tell you whether its push failed.** `CodOrderStatus`
only reaches `FAILED` on some paths, so a `CONFIRMED` order can carry five
`pushAttempts` and no error. Anything triaging stuck orders has to read
`pushAttempts`, not just the status — `OrdersPage.isFailing` does.

**`findStuck` and `liveCounters` must agree.** The dashboard tile links to the
Orders screen, so if their filters differ the tile says three and the page lists
four. Both now exclude `riskAction: BLOCK` — a blocked order is terminal at the
gate, so listing it offers a retry that can never succeed.

**There are two postal-code mechanisms and they are not the same.**
`allowedPostalPatterns` / `blockedPostalPatterns` on `ShopSettings` run in
`postal/service.ts` at PIN entry — a shopper outside the area is told before
filling the form. A `POSTAL_CODE` entry in the fraud block list scores the order
*after* submission and defers to the thresholds. Both screens now sit on the
fraud tab (`DeliveryAreaPanel` for coverage, the block lists for risk), which
makes them easy to confuse; the panel's own copy is what keeps them apart. The
fields are still served by `/admin/shop/visibility` — the move was navigation
only.

**Form translations were plumbed end to end for months with no way to write
one.** The `translations` columns, `localizeForm`, the theme sending
`request.locale.iso_code`, and the submission path localizing before it
validates — all of it worked, and every form still rendered in English because
nothing could author a translation. `TranslationsPanel` is that missing half.
Languages come from `ShopSettings.enabledLocales`, which `syncLocales` adopts
from the storefront at install, so the list is never a second thing to maintain.
Empty means *fall back*: `localizeForm` uses `??`, which is why a partial
translation is safe and no reset control exists.

**The Vite dev server proxies only the prefixes it is told to.** Anything else
the API serves falls through to the SPA catch-all and renders the admin shell
instead. It works in production, where the API serves both, so the difference
only shows up when someone opens the URL they put on the App Store listing.
`/api` and `/legal` are both configured in `vite.config.ts`; add the prefix
there when adding another non-`/api` route.

**App Bridge's nav menu cannot nest.** Shopify's docs are explicit: navigation
items may not contain other items. Grouping is done with `components/SectionTabs.tsx`
— a tab strip shared by the routes in a section — and every tab is a *route*,
not component state, because the dashboard links to `/orders`, Store health to
`/settings/pixels`, and Google's OAuth callback returns to
`/settings/sheets?google_connected=1`. Adding a screen means adding it to a
section's tab list, not to the sidebar.

**Polaris `Tabs` cannot be clicked in jsdom.** It measures tab widths to decide
its overflow menu, every width is zero, and the duplicate elements it renders
swallow the click — so `onSelect` never fires. Test the selection rule through
`tabIndexFor` instead. `Tabs` also needs a `ResizeObserver` stub, which
`tests/setup.ts` now provides.

**Polaris uses `aria-disabled`, not the native attribute.**

**Webhooks mount before `express.json`.** The HMAC covers exact bytes.

---

## Known gaps

### Built since the last handoff, none of it released

All dev-only. The live storefront still runs `codflow-codkar-4`.

| What | Where | State |
|---|---|---|
| **Data retention** | `jobs/enforceRetention.ts`, `ShopSettings.orderRetentionDays` | Tested; **never run against real rows** |
| **Profiling opt-out** | `fraud/engine.ts`, `CodOrder.profilingOptOut` | Tested; needs a `CONSENT` field keyed `profilingOptOut` |
| **Logo actually renders** | `theme-src/src/form.ts` `syncDialogLogo` | `brandLogoUrl` reached the config for months with nothing drawing it |
| **Logo height / alignment** | `brandLogoHeight`, `brandLogoAlignment` | Confirmed working through the real admin |
| **Fees screen** | `/settings/fees`, `shop/service.updateFees` | Confirmed working through the real admin |
| **Import / export** | `modules/transfer/`, `/settings/backup` | Round-trip verified live |
| **Upsells → order bumps** | `modules/upsells/`, `OrderBump`, `/upsells` | Server path verified live; **tick boxes never seen render** |
| **Plan exemption** | `lib/planExemption.ts`, `PLAN_EXEMPT_SHOPS` | Verified: FREE → ENTERPRISE by env alone |
| **Telegram support button** | `components/SupportWidget.tsx`, `SUPPORT_TELEGRAM_URL` | Build-time constant, renders nothing when unset |

Pricing was changed to **$9 / $18 / $26** with **3-day** trials on Starter and
Pro. `monthlyUsd` is display only — the amount charged lives in the Partner
Dashboard's managed pricing and **must be changed there too**, or a merchant
reads one figure and is billed another.

Two things on the Upsells screen — 1-click upsells and downsells — are shown as
*not available* rather than as buttons that lead nowhere. They need an offer
state machine and exit detection respectively.

### Unverified rather than broken

- **Nothing from the most recent sessions is released.** The postal lookup,
  country fallback, `orderStatusUrl` handoff, the BullMQ fix, the button
  customizer, and now data retention and the profiling opt-out are all dev-only;
  the live storefront still runs `codflow-codkar-4`. **Deploying is the first
  thing to do** — and note the worker is what installs the retention schedule,
  so a deploy that ships only the web process leaves the sweep uninstalled.
- **Nothing in the admin has been seen rendered since the save-bar fix.** The
  SPA cannot render outside Shopify's iframe — App Bridge has no session token
  there — so the button customizer, the pixel screen, and the `<ui-save-bar>`
  now used by four screens are covered by tests but have not been watched
  working. The save bar in particular has a fallback path for when App Bridge
  lacks `saveBar`; which path actually runs in the admin is unconfirmed.
- **No pixel has ever been configured against a real ad platform.** The screen
  drives all six endpoints, but no Meta or Google credential has been entered on
  the test store, so nothing past the API boundary is proven — the providers'
  own responses, and whether the event tester's synthetic payload is accepted,
  are unknown. `POST /pixels/:id/test` is the fastest way to find out.
- **`prisma migrate deploy` has now run**, against the local Postgres 17, for
  the sixth migration. Against a *hosted* database it still never has.
- **The retention sweep has never run.** It is covered by tests that mock the
  repository, so the batching, the per-shop ceiling and the continue-on-failure
  behaviour are proven, but `anonymiseExpiredOrders` has never executed against
  real rows and no sweep has been watched clearing an actual order. The test
  store's orders are all newer than the 365-day default, so nothing will expire
  there without backdating a `createdAt` or lowering `orderRetentionDays` by
  hand. Worth doing once before release — this is a job whose whole purpose is
  destroying data.
- **`orderRetentionDays` has no admin screen.** The column and its enforcement
  exist; changing it means a SQL update. That is why the privacy policy says the
  period "can be adjusted on request" rather than claiming merchants can set it
  — do not upgrade that wording without building the control. It belongs with
  the ungoverned `ShopSettings` corners in item 6.
- **The Docker image has never been built.** CI builds it and asserts the
  container starts and rejects an unsafe production config.
- **Managed pricing plans do not exist** in the Partner Dashboard. Their display
  names must match `PLAN_CATALOGUE` (`Free`, `Starter`, `Pro`, `Enterprise`) —
  that string is the only signal Shopify returns about which plan was bought.
- **Google Sheets is unconfigured.** `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
  are blank, so the connect button correctly reports the feature is off — a 503
  from `google/client.assertConfigured`, not a crash. Turning it on needs a
  Google Cloud OAuth client, the two secrets in `.env`, and
  `GOOGLE_REDIRECT_URI` set to `<app url>/api/google/callback` *and* added to
  the authorised list in Google Cloud. `npm run preflight` now checks that last
  one — see Traps.

### Real work, ordered by value

1. **Deploy the current work** (see above).
2. **Fill in the legal pages before submitting to the App Store.** Drafts are in
   `docs/legal/`, served at `/legal/{privacy,terms,dpa,support}`. Every
   `[PLACEHOLDER]` needs a real value and the lot needs a lawyer.

   The two gaps that were in the *product* rather than the paperwork — no
   retention limit and no shopper opt-out from automated scoring — are now
   closed; see Data retention below. What is left here is genuinely paperwork,
   plus the one open question `docs/legal/README.md` records: nothing obliges a
   merchant to put the opt-out field on their form, so a store that never adds
   it offers no opt-out. Seeding it into `DEFAULT_FORM_FIELDS` would settle
   that, and is a five-line change if the lawyer says it must be universal.
3. **Popup vs embedded form modes** — the form is popup-only; `openInPopup`
   exists on `ButtonConfig` and `StorefrontButton` and is not honoured. The
   customizer deliberately does not expose it; it belongs with this work.
   `iconName` is unhonoured and unexposed for the same reason.
4. **Bulk retry on the Orders screen.** The list is paged and grouped now, but
   500 stuck orders is still 500 clicks. Bound it per call the way
   `rescanPending` caps itself at 200, and enqueue rather than pushing inline.
   Each row also mounts its own `useRetryPush` *and* `useVerifyOrder`, so 50
   rows is 100 mutation instances rebuilt on every poll — lift them to one per
   page while in there.

   Note the screen is the *symptom*. Thousands of stuck orders means the worker
   is not keeping up or pushes are failing en masse; store health already
   computes the number and nothing alerts on it.

5. **Order detail — what the shopper actually typed.** *(Requested last, after
   the above.)* A merchant needs to see the name, phone and address on a held
   order to judge whether it is real or bogus, which is the core COD decision
   and currently impossible from the admin.

   Build it as a **detail view fetched per order**, not as fields on the list.
   `StuckOrderSummary` omits personal data on purpose — a recovery list is about
   *which* orders are stuck, and putting every shopper's address into a payload
   that is polled every fifteen seconds is how a support tool becomes a privacy
   incident. A `GET /orders/:reference` opened on demand keeps the list lean
   (which item 3 depends on) and means the data is read only when someone
   actually looks. `repository.collectCustomerData` already assembles this shape
   for the GDPR export and is the obvious starting point.
6. **`ShopSettings` still has ungoverned corners.** Branding is at
   `/settings/appearance` and the eligibility rules at `/settings/visibility`.
   What remains without a screen: the COD fee and shipping rules
   (`codFeeEnabled`, `codFeeAmount`, `shippingFee`, `freeShippingAbove`), order
   handling (`defaultOrderTags`, `autoFulfill`, `markAsPaid`,
   `inventoryBehaviour`), localization and the notification toggles. All are
   honoured by the storefront or the push pipeline.
7. **Fraud detectors have no direct tests** — the engine tests mock
   `runDetectors` wholesale. PGlite fixtures make this possible now.
8. **OTP** — model, gates, plan feature and the `otp_sends` meter all exist.
   Nothing sends a code.
9. **`codflow.js` is 39 KB against Shopify's 10 KB app-block threshold.** Logged
   as an error at deploy but not blocking. Mostly comments; minifying into
   `assets/` at build time would fix it. Will matter at app review.

### Loose ends on the test store

**The local database was wiped** when Docker was reinstalled on 2 August 2026 —
containers *and* volumes. It was rebuilt with `docker compose up -d`, all five
migrations applied with `migrate deploy`, and the shop re-provisioned with
`SEED_SHOP_DOMAIN=codkar-th9dk7h6.myshopify.com npm run prisma:seed`. What did
not come back: the earlier test orders, the Shopify sessions, and the plan
override. Anything in this file referring to specific `CF-` references from
before that date is history, not current state.

**The subscription is set to ENTERPRISE by hand** so every plan-gated feature is
testable. It is a data change, not a code change — revert with:

```sql
update subscriptions set plan='FREE'
where "shopId" = (select id from shops where domain='codkar-th9dk7h6.myshopify.com');
```

**The app block on the product template is set to Placement: Home page**, so its
slot never fills; the visible button comes from auto-placement. Either move the
block back to Product page, or enable the Home page button in the customizer.

**Docker is now a per-user install** (`AppData\Local\Programs\DockerDesktop`)
rather than in Program Files, so `docker` is not on the shell PATH by default.

---

## Where the seams are

**Push gates** (`modules/orders/gates.ts`) *read* `riskAction` and `otpVerified`;
they never compute them. OTP lands the same way fraud did.

**The profiling opt-out rides on that seam and needs nothing else.** A shopper
who refuses automated decisions gets a `BLOCK` downgraded to `REVIEW` in
`fraud/engine.ts`, and a REVIEW order is already a CONFIRMED order the push
gates hold — so putting a person in the loop took no new plumbing. Two things
about it are deliberate and easy to undo by accident: it is applied *after* the
blacklist override, making it the only thing in the engine that outranks a
blacklist entry (a merchant's list cannot waive a shopper's right), and it
withdraws only the power to *refuse* — the order is still scored and every
signal still recorded, because the merchant needs that to make the call. The
flag reaches the order two ways, `input.profilingOptOut` or a `CONSENT` form
field keyed `profilingOptOut`, OR'd together in `orders/service.ts`.

**Queues** — eight declared, six with processors (`ORDER_PUSH`, `SHEET_SYNC`,
`FRAUD_SCAN`, `PIXEL_DISPATCH`, `STATS_REBUILD`, `DATA_RETENTION`). `AUTOMATION`
and `NOTIFICATION` are unused.

`DATA_RETENTION` is the only *scheduled* queue — everything else is enqueued by
something that happened. `scheduleRetentionSweep()` installs it from the worker
on boot with `upsertJobScheduler`, which is idempotent; the older
`add({ repeat })` API would leave a second scheduler behind on every pattern
change, and two sweeps a night with nothing in the app saying so.

**Data retention** — `ShopSettings.orderRetentionDays` (365 by default, no "off"
value) and `jobs/enforceRetention.ts`, which runs at 03:00 and clears the
personal columns of orders past the cutoff. It *blanks* rather than deletes, and
shares the column list with `customers/redact` through
`shop/repository.REDACTION` — the two must agree, because a field added to one
and not the other is a field that survives a redaction. `CodOrder.redactedAt`
is both the record and the "already done" marker that keeps the sweep from
re-examining a shop's whole history nightly.

**`stats.record*`** is the only place a dashboard counter is incremented, and
nothing in it can throw at its caller.

**Webhooks** — all five order topics have processors. Deliveries stored before a
processor existed are still pending, so `webhooks/service.replay(topic)` folds
that backlog in rather than starting history at the deploy.

**Postal providers** (`lib/postal.ts`) — one per country, currently India only.
Adding a country is a provider plus an entry in `POSTAL_FORMATS`.

**`FormConfig` carries more than the builder edits.** The wording — heading,
sub-heading, submit button, success message — is reachable now via the submit
row in the field list. The layout and behaviour flags beside it (`layout`,
`showOrderSummary`, `showCouponField`, `showTermsCheckbox`, `termsUrl`,
`trackAbandonment`, `botProtection`, `minFillSeconds`) are accepted by
`UpdateFormSchema` and honoured by the storefront, and still have no UI.

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

Copy `.env.example` to `.env`. Beyond the obvious, three matter:

- `SHOPIFY_APP_HANDLE` must equal `handle` in `shopify.app.toml`
  (`codflow-codkar`).
- `ENCRYPTION_KEY` is permanent — rotating it makes every stored Google refresh
  token undecryptable.
- `APP_URL` must match `application_url` exactly. Under `shopify app dev` the CLI
  supplies it as `SHOPIFY_APP_URL` and that value wins, because the tunnel
  hostname changes every run.

**The tunnel changes on every `shopify app dev` run**, and `shopify app deploy`
pins whatever is in `shopify.app.toml` into the live app. Redeploy after
restarting dev, or use a stable tunnel — see [DEPLOYMENT.md](DEPLOYMENT.md),
which is also the production runbook.
