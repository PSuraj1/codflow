-- Row layout options for the Google Sheets sync.
--
-- `singleRowPerOrder` decides whether a multi-item order becomes one row or one
-- row per line item. `insertAtTop` prepends beneath the header instead of
-- appending. `headerRow` records where the headers live so the sync knows which
-- row data starts on.
--
-- All three are NOT NULL with defaults, so existing rows adopt the previous
-- behaviour without a backfill: appending at the bottom was the only behaviour
-- before this migration, and a header on row 1 was implied by `nextRow`
-- defaulting to 2.
--
-- Hand-written rather than generated: `prisma migrate diff --from-migrations`
-- requires a shadow database, which is not available in this environment. The
-- column names and types match exactly what Prisma emits for these fields —
-- compare against the `sheet_configs` table in the init migration.
ALTER TABLE "sheet_configs"
    ADD COLUMN "singleRowPerOrder" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "insertAtTop" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "headerRow" INTEGER NOT NULL DEFAULT 1;
