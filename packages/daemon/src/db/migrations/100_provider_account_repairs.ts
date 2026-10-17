import type { Migration } from "../migrate.js";

export const providerAccountRepairsSchema: Migration = {
  name: "100_provider_account_repairs.sql",
  sql: `CREATE TABLE provider_account_repairs (
    node_id TEXT PRIMARY KEY, to_account TEXT NOT NULL, native_session TEXT NOT NULL,
    generation TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT
  );`,
};
