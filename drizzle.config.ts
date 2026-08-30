import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit generates the migration SQL from `src/storage/schema.ts`
 * (ADR-002). Applying it is not drizzle-kit's job here: the application does
 * that at start-up, through `openDatabase` in `src/storage/database.ts`.
 *
 * Regenerate with `npm run db:generate` after changing the schema, and commit
 * both the SQL file and the journal.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/storage/schema.ts",
  out: "./drizzle",
});
