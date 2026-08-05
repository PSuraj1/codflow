import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Migration verification.
 *
 * Applies every migration, in order, to a real PostgreSQL instance — PGlite is
 * Postgres compiled to WASM, not an emulation, so the SQL is parsed and
 * executed by the same engine that will run it in production.
 *
 * This exists because the initial migration was generated offline with
 * `prisma migrate diff` and the second was written by hand, and neither had
 * ever been applied to a database. "Prisma generated it, so it must be valid"
 * is an assumption, and the cost of it being wrong is a deployment whose
 * release command fails after the image is already rolling out.
 *
 * The assertions deliberately check *structure* rather than counting rows:
 * cascade rules, unique constraints and column types are the things a
 * hand-written migration gets wrong, and each of them has a specific
 * consequence spelled out below.
 */

const MIGRATIONS_DIR = join(__dirname, '../../prisma/migrations');
const SCHEMA_PATH = join(__dirname, '../../prisma/schema.prisma');

let db: PGlite;

/** Migration directories in the order Prisma applies them: lexical by name. */
function migrationDirectories(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((entry) => statSync(join(MIGRATIONS_DIR, entry)).isDirectory())
    .sort();
}

async function tableNames(): Promise<string[]> {
  const result = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name`,
  );
  return result.rows.map((row) => row.table_name);
}

async function columnsOf(table: string): Promise<Record<string, { type: string; nullable: boolean; default: string | null }>> {
  const result = await db.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `select column_name, data_type, is_nullable, column_default
     from information_schema.columns
     where table_schema = 'public' and table_name = $1`,
    [table],
  );

  return Object.fromEntries(
    result.rows.map((row) => [
      row.column_name,
      {
        type: row.data_type,
        nullable: row.is_nullable === 'YES',
        default: row.column_default,
      },
    ]),
  );
}

beforeAll(async () => {
  db = await PGlite.create();

  for (const directory of migrationDirectories()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, directory, 'migration.sql'), 'utf8');
    // Throws on any invalid statement, which is the whole point.
    await db.exec(sql);
  }
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('migration files', () => {
  it('every directory carries a migration.sql', () => {
    for (const directory of migrationDirectories()) {
      expect(() => readFileSync(join(MIGRATIONS_DIR, directory, 'migration.sql'))).not.toThrow();
    }
  });

  /**
   * Without `migration_lock.toml`, `prisma migrate deploy` treats the directory
   * as uninitialised and applies nothing — silently, so the deploy succeeds and
   * the app starts against an empty database.
   */
  it('declares the provider lock', () => {
    const lock = readFileSync(join(MIGRATIONS_DIR, 'migration_lock.toml'), 'utf8');
    expect(lock).toContain('provider = "postgresql"');
  });
});

describe('applied schema', () => {
  it('creates every table the Prisma schema maps', async () => {
    // Parsed from the schema rather than hardcoded, so a model added without a
    // migration fails here instead of at deploy time.
    const schema = readFileSync(SCHEMA_PATH, 'utf8');
    const mapped = [...schema.matchAll(/@@map\("([^"]+)"\)/g)].map((match) => match[1]);

    const created = await tableNames();

    expect(mapped.length).toBeGreaterThan(20);
    for (const table of mapped) {
      expect(created).toContain(table);
    }
  });

  it('creates the Shopify session table with the shape the storage package requires', async () => {
    // Field names here are dictated by
    // @shopify/shopify-app-session-storage-prisma. Renaming one breaks session
    // storage at runtime rather than at compile time.
    const columns = await columnsOf('shopify_sessions');

    for (const required of ['id', 'shop', 'state', 'isOnline', 'accessToken']) {
      expect(columns).toHaveProperty(required);
    }

    expect(columns.accessToken?.nullable).toBe(false);
    expect(columns.refreshToken?.nullable).toBe(true);
  });

  it('stores money as fixed-point numeric, never floating point', async () => {
    // A float total is one a courier cannot collect exactly.
    const columns = await columnsOf('cod_orders');

    for (const money of ['subtotal', 'shippingFee', 'codFee', 'discount', 'total']) {
      expect(columns[money]?.type).toBe('numeric');
    }
  });

  it('makes the order reference unique', async () => {
    const result = await db.query<{ count: number }>(
      `select count(*)::int as count from pg_indexes
       where tablename = 'cod_orders' and indexdef like '%UNIQUE%reference%'`,
    );
    expect(result.rows[0]?.count).toBeGreaterThan(0);
  });

  /**
   * The constraint that turns Shopify's at-least-once webhook delivery into
   * effectively-once processing. Without it a retried delivery is processed
   * twice — double-counting an order, or re-firing a Purchase event at Meta.
   */
  it('makes the Shopify webhook id unique', async () => {
    const result = await db.query<{ count: number }>(
      `select count(*)::int as count from pg_indexes
       where tablename = 'webhook_events' and indexdef like '%UNIQUE%shopifyWebhookId%'`,
    );
    expect(result.rows[0]?.count).toBeGreaterThan(0);
  });

  /**
   * `shop/redact` deletes the tenant root and relies entirely on the cascade to
   * remove everything else. A model missing it would silently retain merchant
   * data past the point the app promised to erase it — a compliance failure
   * that no test of the handler itself would catch.
   */
  it('cascades deletes from the shop root', async () => {
    const result = await db.query<{ table_name: string }>(
      `select tc.table_name
       from information_schema.table_constraints tc
       join information_schema.referential_constraints rc
         on tc.constraint_name = rc.constraint_name
       join information_schema.constraint_column_usage ccu
         on rc.unique_constraint_name = ccu.constraint_name
       where tc.constraint_type = 'FOREIGN KEY'
         and ccu.table_name = 'shops'
         and rc.delete_rule = 'CASCADE'`,
    );

    const cascading = result.rows.map((row) => row.table_name);

    // Every table that carries a shopId and holds merchant or shopper data.
    for (const table of [
      'cod_orders',
      'shop_settings',
      'form_configs',
      'google_accounts',
      'sheet_configs',
      'pixels',
      'risk_assessments',
      'otp_verifications',
      'audit_logs',
    ]) {
      expect(cascading).toContain(table);
    }
  });
});

/**
 * Drift between the Prisma schema and the applied migrations.
 *
 * The definitive check would be `prisma migrate diff --from-url` against the
 * applied database, asserting an empty diff. That needs the Prisma CLI to spawn
 * against a live server, which this environment blocks, so the equivalent is
 * done here directly: parse the schema, and assert every scalar field of every
 * model exists as a column with matching nullability.
 *
 * It catches the failure that matters — a model field added without a
 * migration, which type-checks perfectly and then throws
 * `column does not exist` on the first query in production.
 */
describe('schema parity', () => {
  interface ParsedField {
    readonly name: string;
    readonly optional: boolean;
    readonly list: boolean;
  }

  interface ParsedModel {
    readonly table: string;
    readonly fields: readonly ParsedField[];
  }

  /** Prisma's scalar types. Anything else is an enum or a relation. */
  const SCALARS = new Set([
    'String',
    'Int',
    'BigInt',
    'Float',
    'Decimal',
    'Boolean',
    'DateTime',
    'Json',
    'Bytes',
  ]);

  function parseSchema(): ParsedModel[] {
    const schema = readFileSync(SCHEMA_PATH, 'utf8');

    // Model and enum names, so relation fields can be told from scalars.
    const modelNames = new Set([...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]!));
    const enumNames = new Set([...schema.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((m) => m[1]!));

    const models: ParsedModel[] = [];

    for (const block of schema.matchAll(/^model\s+\w+\s*\{([\s\S]*?)^\}/gm)) {
      const body = block[1] ?? '';
      const table = /@@map\("([^"]+)"\)/.exec(body)?.[1];

      // A model without @@map keeps its own name as the table; every model in
      // this schema maps, so its absence is a schema error rather than a case
      // to handle.
      if (!table) continue;

      const fields: ParsedField[] = [];

      for (const line of body.split('\n')) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;

        const match = /^(\w+)\s+(\w+)(\[\])?(\?)?/.exec(trimmed);
        if (!match) continue;

        const [, name, type, isList, isOptional] = match;
        if (!name || !type) continue;

        // A list of a model is a relation; a list of a scalar or enum is a real
        // array column, which Postgres supports.
        if (modelNames.has(type)) continue;
        if (!SCALARS.has(type) && !enumNames.has(type)) continue;
        if (isList && modelNames.has(type)) continue;

        fields.push({ name, optional: Boolean(isOptional), list: Boolean(isList) });
      }

      models.push({ table, fields });
    }

    return models;
  }

  it('parses a plausible number of models', () => {
    // Guards the parser itself: a regex that silently matched nothing would
    // make every assertion below vacuously pass.
    const models = parseSchema();
    expect(models.length).toBeGreaterThan(20);
    expect(models.every((model) => model.fields.length > 0)).toBe(true);
  });

  it('has a column for every scalar field in the schema', async () => {
    const missing: string[] = [];

    for (const model of parseSchema()) {
      const columns = await columnsOf(model.table);

      for (const field of model.fields) {
        if (!(field.name in columns)) {
          missing.push(`${model.table}.${field.name}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('matches nullability between the schema and the database', async () => {
    const mismatched: string[] = [];

    for (const model of parseSchema()) {
      const columns = await columnsOf(model.table);

      for (const field of model.fields) {
        const column = columns[field.name];
        if (!column) continue;

        /**
         * Scalar lists are exempt, and this is Prisma's behaviour rather than a
         * gap in the migration: `String[]` becomes a nullable `text[]` column
         * with a `'{}'` default, while the client treats the field as required
         * and never writes null into it. Asserting NOT NULL here would fail
         * against a schema Prisma itself generated — which is exactly what the
         * first run of this test did, across all fourteen array columns.
         */
        if (field.list) continue;

        // A field the schema calls optional but the column marks NOT NULL
        // fails on insert; the reverse silently accepts nulls the client
        // believes cannot occur.
        if (column.nullable !== field.optional) {
          mismatched.push(
            `${model.table}.${field.name}: schema=${field.optional ? 'optional' : 'required'} db=${column.nullable ? 'nullable' : 'not null'}`,
          );
        }
      }
    }

    expect(mismatched).toEqual([]);
  });

  it('has no columns the schema does not declare', async () => {
    const orphaned: string[] = [];

    for (const model of parseSchema()) {
      const declared = new Set(model.fields.map((field) => field.name));
      const columns = await columnsOf(model.table);

      for (const column of Object.keys(columns)) {
        // An extra column is a migration that ran without a matching schema
        // change — harmless until someone adds a field with the same name and
        // a different type.
        if (!declared.has(column)) orphaned.push(`${model.table}.${column}`);
      }
    }

    expect(orphaned).toEqual([]);
  });
});

describe('the hand-written sheet layout migration', () => {
  /**
   * Written by hand because `prisma migrate diff --from-migrations` needs a
   * shadow database. These assertions are what makes that safe: the columns,
   * their types and their defaults all have to match what Prisma expects, or
   * the client and the database disagree at runtime.
   */
  it('adds the row layout columns with the documented defaults', async () => {
    const columns = await columnsOf('sheet_configs');

    expect(columns.singleRowPerOrder?.type).toBe('boolean');
    expect(columns.singleRowPerOrder?.nullable).toBe(false);
    expect(columns.singleRowPerOrder?.default).toContain('true');

    expect(columns.insertAtTop?.type).toBe('boolean');
    expect(columns.insertAtTop?.nullable).toBe(false);
    expect(columns.insertAtTop?.default).toContain('false');

    expect(columns.headerRow?.type).toBe('integer');
    expect(columns.headerRow?.nullable).toBe(false);
    expect(columns.headerRow?.default).toContain('1');
  });

  /**
   * NOT NULL with a default means existing rows adopt the previous behaviour
   * without a backfill — appending at the bottom, header on row 1. A column
   * added without a default would fail against a table that already has rows.
   */
  it('leaves existing rows usable without a backfill', async () => {
    await db.exec(`
      insert into shops (id, domain, "currencyCode", "primaryLocale", timezone, "createdAt", "updatedAt")
      values ('shop-1', 'demo.myshopify.com', 'INR', 'en', 'UTC', now(), now());

      insert into google_accounts (id, "shopId", "googleUserId", email, "accessTokenEnc", "refreshTokenEnc", "tokenExpiresAt", "createdAt", "updatedAt")
      values ('ga-1', 'shop-1', 'g-1', 'a@example.com', 'enc', 'enc', now(), now(), now());

      insert into sheet_configs (id, "shopId", "googleAccountId", "spreadsheetId", "createdAt", "updatedAt")
      values ('sc-1', 'shop-1', 'ga-1', 'sheet-1', now(), now());
    `);

    const result = await db.query<{
      singleRowPerOrder: boolean;
      insertAtTop: boolean;
      headerRow: number;
    }>(`select "singleRowPerOrder", "insertAtTop", "headerRow" from sheet_configs where id = 'sc-1'`);

    expect(result.rows[0]).toEqual({
      singleRowPerOrder: true,
      insertAtTop: false,
      headerRow: 1,
    });
  });
});

describe('idempotency of a fresh apply', () => {
  /**
   * A second apply to a fresh database must produce the same result. This
   * catches a migration that depends on state left by a previous run — the
   * failure mode where the first deploy to a new environment behaves
   * differently from every subsequent one.
   */
  it('applies cleanly to a second fresh database', async () => {
    const second = await PGlite.create();

    try {
      for (const directory of migrationDirectories()) {
        const sql = readFileSync(join(MIGRATIONS_DIR, directory, 'migration.sql'), 'utf8');
        await expect(second.exec(sql)).resolves.toBeDefined();
      }

      const result = await second.query<{ count: number }>(
        `select count(*)::int as count from information_schema.tables
         where table_schema = 'public' and table_type = 'BASE TABLE'`,
      );

      expect(result.rows[0]?.count).toBe((await tableNames()).length);
    } finally {
      await second.close();
    }
  }, 60_000);
});
