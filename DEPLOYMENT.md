# Deploying CodFlow

Everything needed to take this from a repository to a Shopify app merchants can
install. [HANDOFF.md](HANDOFF.md) says where the code is; this says how to run
it.

Two processes, one image:

```
web     node apps/api/dist/server.js        Express, the embedded admin, webhooks, the app proxy
worker  node apps/api/dist/queue/worker.js  Order pushes, Sheets sync, pixel dispatch, fraud scans
```

They are separate because they scale on different pressures — web capacity
follows concurrent shoppers, worker capacity follows how fast Shopify accepts
writes. Sharing one process means a backlog of order pushes competes with
request handling for a single event loop, and merchants see slow product pages
during their own busy hour.

---

## Before the first deploy

### 1. Provision

| Resource | Minimum | Why |
|---|---|---|
| PostgreSQL | 17, 256 MB | The schema uses `jsonb`, partial indexes and `text[]` |
| Redis | 256 MB, **`noeviction`** | BullMQ's store — see the warning below |
| Web | 512 MB | Node plus the Prisma query engine |
| Worker | 512 MB | Same image, no HTTP listener |

> **Redis must not evict.** BullMQ keeps job state in Redis. A key dropped by an
> LRU policy is work that silently never happens — an order that never reaches
> Shopify, with nothing anywhere recording that it was lost. `noeviction` makes
> Redis reject the write instead, which surfaces as an error the app logs and
> retries. Managed Redis defaults to `allkeys-lru` on several platforms; check it.

### 2. Environment

Copy `.env.example` and fill it in. The app refuses to start in production with
unsafe values — see [Boot-time guards](#boot-time-guards) — but these are the
ones with consequences beyond a failed boot:

```bash
# Permanent. Rotating this makes every stored Google refresh token
# undecryptable, and every merchant has to reconnect their spreadsheet.
openssl rand -base64 32   # ENCRYPTION_KEY

openssl rand -hex 32      # SESSION_SECRET
```

`APP_URL` must match `application_url` in `shopify.app.toml` **exactly**.
Shopify validates the OAuth redirect against it, and a trailing slash or a
different host fails the install with an error that names neither.

`SHOPIFY_APP_HANDLE` must match `handle` in `shopify.app.toml`. It only builds
the managed-pricing URL, so a wrong value produces a Shopify 404 on the upgrade
button rather than anything the app can detect.

### 3. Shopify Partner Dashboard

The app cannot be finished from code alone. Four things live in the dashboard:

1. **App URLs** — set the application URL and the allowed redirection URLs to
   match `shopify.app.toml`. `shopify app deploy` does this from the TOML.
2. **Managed pricing plans** — create four, named exactly `Free`, `Starter`,
   `Pro`, `Enterprise`. That display name is the *only* signal Shopify returns
   about which plan a merchant bought; `resolvePlan` maps it back onto the
   `Plan` enum. Renaming a plan there is the single most likely way to break
   entitlements. (`resolvePlan` tolerates decoration like `Pro — Annual`, and
   falls back to Starter rather than Free on a name it does not recognise.)
3. **App proxy** — `shopify app deploy` configures it from `[app_proxy]`.
4. **Webhook subscriptions** — likewise, from `[[webhooks.subscriptions]]`.

### 4. Protected customer data access — required before the first deploy

`shopify app deploy` **fails** until this is granted:

```
Version couldn't be created.
  • This app is not approved to subscribe to webhook topics containing
    protected customer data.
```

Five errors, one per order topic: `orders/create`, `orders/updated`,
`orders/cancelled`, `orders/fulfilled`, `refunds/create`. All of them carry
customer names, addresses and phone numbers, so Shopify gates them behind an
explicit request.

**Partner Dashboard → your app → App setup → Protected customer data access →
Request access.** Ask for the protected data itself plus the four fields a COD
order cannot work without: name, email, phone, address. For a development app
this is granted immediately; a public listing gets reviewed.

There is nothing to change in the code — the subscriptions in
`shopify.app.toml` are already correct, they just cannot be created yet.

### 5. Google Cloud (only if Sheets sync is offered)

An OAuth client with `GOOGLE_REDIRECT_URI` set to
`https://<your-host>/api/google/callback`. Request `drive.file`, **not**
`drive` — the broader scope triggers Google's annual third-party security
assessment, which costs real money and months.

---

## Testing on a development store

Before any of the below, the app has to work on a real store. The loop:

```bash
shopify auth login
shopify app config link          # writes client_id and handle into shopify.app.toml
docker compose up -d
npm run prisma:migrate && npm run prisma:seed
npm run preflight                # verifies the setup before anything runs
npm run dev                      # CLI starts api + admin and owns the tunnel
```

`npm run preflight` checks the things that otherwise present as "the app is
broken": whether `.env` is being read at all, whether Postgres and Redis answer,
whether the migrations are applied, whether Redis will evict BullMQ's jobs, and
whether `SHOPIFY_API_KEY` and `APP_URL` agree with `shopify.app.toml`. The last
two are the valuable ones — a key that does not match `client_id` makes
installation loop through consent forever, and nothing in the running app can
detect either.

Then **Partner Dashboard → your app → Test on development store**.

`shopify app dev` rewrites `application_url`, the redirect URLs and the app
proxy URL on every run, because the tunnel hostname changes. That is convenient
for a single session and tiresome across several — for longer testing, set
`automatically_update_urls_on_dev = false`, point everything at a stable
Cloudflare or ngrok hostname, and start the processes yourself. See the local
setup section of [README.md](README.md).

Two things only exist once `shopify app deploy` has run: the **app proxy**
(without it the storefront's `/apps/codflow/*` calls 404) and the **theme app
extension** (without it there is no app embed to switch on). `shopify app dev`
serves a draft of the extension for preview; deploy makes it real.

What to walk through, in the order things break:

1. **Install** — the dashboard should render with the store name and a `FREE`
   badge. A blank iframe means `APP_URL` and `application_url` disagree.
2. **App embed** — Online Store → Themes → Customize → App embeds → enable
   CodFlow, then place the COD button block on a product template.
3. **One COD order.** The highest-risk path in the codebase: the draft-order
   mutation shapes have never run against a live store. If the push fails,
   `cod_orders.pushError` holds Shopify's own message, the worker logs the full
   GraphQL response, and `POST /api/admin/orders/:reference/retry-push` re-runs
   it after a fix. The mutations are in `apps/api/src/shopify/mutations/`.
4. **Cancel or fulfil that order in Shopify.** A row should appear in
   `webhook_events` with `status: PROCESSED`, and the cancellation on the
   analytics screen. A `FAILED` row keeps the full payload, so fix the handler
   and replay rather than re-creating the order.
5. **Billing.** Create the four plans first (see above). Development stores
   always get test charges, so subscribing and cancelling costs nothing.

---

## Deploying

### Railway

`railway.json` is committed. Railway reads it on deploy.

```bash
railway up
```

Add a second service from the same repository for the worker, with the start
command `node apps/api/dist/queue/worker.js` and no health check. Railway's
`preDeployCommand` runs `npm run release` (`prisma migrate deploy`) once per
deploy, before any instance takes traffic.

### Render

`render.yaml` is a full blueprint — web, worker, Postgres and Redis.

```bash
render blueprint launch
```

Render prompts for every `sync: false` secret once. `ENCRYPTION_KEY` and
`SESSION_SECRET` are generated by Render and shared with the worker by
reference, so the two processes cannot drift apart — a worker with a different
encryption key cannot decrypt the Google tokens it needs to sync.

### Anywhere else

```bash
docker build -t codflow .
docker run --env-file .env -p 3000:3000 codflow                          # web
docker run --env-file .env codflow node apps/api/dist/queue/worker.js    # worker
```

Run `npm run release` against the same database before starting either.

### The theme extension

Deployed to Shopify, not to your host:

```bash
shopify app deploy
```

This uploads `extensions/codflow-theme/` and registers the app proxy and webhook
subscriptions from `shopify.app.toml`. The built bundles in `assets/` are
committed for exactly this reason — `deploy` uploads whatever is there, whether
or not CI built it first.

---

## Migrations

```bash
npm run release   # prisma migrate deploy
```

Run once per deploy, from the release phase, **before** new instances take
traffic. Not from container start: that runs it once per replica, and two
replicas applying the same migration concurrently is how a partially-applied
schema happens.

Migrations must be **backward compatible with the currently running version**,
because a rolling deploy has both versions live at once. In practice: add
columns nullable or with a default, and drop columns in a later deploy than the
one that stopped writing them.

> Note: these migrations have never been applied by `prisma migrate deploy`
> against a real server — Docker was unavailable in the environment this was
> built in. They *are* applied and asserted against real PostgreSQL 18 through
> PGlite in `src/tests/migrations.test.ts`, including column-level parity with
> the schema in both directions. The first real `migrate deploy` is still worth
> watching.

---

## Health checks

| Path | Question | On failure |
|---|---|---|
| `/api/health` | Is the process wedged? | Restart the container |
| `/api/health/ready` | Can it serve traffic now? | Remove from the load balancer |

Point the platform's health check at **`/api/health/ready`**. Liveness
deliberately touches no dependency: if it checked Postgres, a database blip
would make every replica report unhealthy at once and the platform would restart
all of them — turning a recoverable outage into a cold start with an empty
connection pool.

---

## Boot-time guards

The process refuses to start in production when it finds a value that would fail
silently later:

- `ENCRYPTION_KEY` still set to the example key from `.env.example`
- `SESSION_SECRET` a repeated character
- `APP_URL` on `http://`, or still pointing at `example.com`
- `DATABASE_URL` or `REDIS_URL` pointing at `localhost` — inside a container
  that means the container itself

Each of these otherwise produces a running app that is quietly wrong: a shop
whose Google tokens are encrypted with a publicly known key, an admin iframe
that silently refuses to load, or a process that passes its own dependency check
against nothing and fails on the first real request. Failing at boot turns them
into a deploy that never goes live, which every platform reports loudly.

---

## Rolling back

```bash
# Railway
railway rollback

# Render — redeploy the previous commit from the dashboard
```

**Application rollbacks are safe. Migration rollbacks are not.** `prisma migrate
deploy` has no down-migration, so rolling the app back past a migration leaves
the schema ahead of the code. If the migration was additive — which it should
be — the old code ignores the new columns and runs fine. If it was not, restore
the database from a snapshot rather than trying to hand-write a reversal under
pressure.

---

## After a deploy

1. `GET /api/health/ready` returns 200 with `{ "database": true, "redis": true }`.
2. Install on a development store, open the app, confirm the dashboard renders.
3. Place a COD order on the storefront and watch it reach Shopify. This is the
   one path that has never been exercised against a live store — the draft-order
   mutation shapes are unverified, and the first real order will confirm or
   break them.
4. Check the worker logs for `CodFlow worker started` and a processed job.

---

## Operations

**Scaling.** Web scales on request latency. The worker scales on queue depth;
`QUEUE_CONCURRENCY` (default 10) matters more than replica count, because
Shopify throttles by query cost per shop and more parallelism against one
merchant just produces 429s that the backoff then has to absorb.

**A stuck order.** `GET /api/admin/orders/stuck` lists orders that never reached
Shopify; `POST /api/admin/orders/:reference/retry-push` re-enqueues one. The
dashboard's store-health card surfaces the count.

**Numbers that look wrong.** `POST /api/admin/analytics/rebuild` recomputes any
range from `cod_orders`. Counters are incremented as events happen and can drift
— a webhook retried after the handler already ran, a deploy that dropped an
in-flight increment.

**A missed webhook.** Deliveries are stored with their full payload before any
processing, so `webhooks/service.replay(topic)` drains the backlog after a fix.

**Logs.** Pino JSON on stdout. Every line carries a `requestId` that the API
also returns in error responses, so a merchant's screenshot is enough to find
the request.
