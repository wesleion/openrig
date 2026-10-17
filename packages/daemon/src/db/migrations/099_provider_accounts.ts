import type { Migration } from "../migrate.js";

export const providerAccountsSchema: Migration = {
  name: "099_provider_accounts.sql",
  sql: `
    CREATE TABLE provider_account_bindings (
      node_id TEXT PRIMARY KEY, account_ref TEXT NOT NULL, native_session TEXT NOT NULL,
      generation TEXT NOT NULL, changed_at TEXT NOT NULL
    );
    CREATE TABLE provider_account_operations (
      id TEXT PRIMARY KEY, node_id TEXT NOT NULL, from_account TEXT, to_account TEXT NOT NULL,
      native_session TEXT NOT NULL, generation TEXT NOT NULL, state TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reason TEXT
    );
    CREATE UNIQUE INDEX provider_account_operation_active ON provider_account_operations(node_id)
      WHERE state IN ('prepared','restarting');
    CREATE TABLE provider_rotation_policies (rig_name TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE provider_account_exhaustions (account_ref TEXT PRIMARY KEY, reset_at TEXT, detected_at TEXT NOT NULL);
    CREATE TABLE provider_quota_incidents (
      node_id TEXT PRIMARY KEY, account_ref TEXT NOT NULL, native_session TEXT NOT NULL,
      generation TEXT NOT NULL, detected_at TEXT NOT NULL, reset_at TEXT,
      notified INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL
    );
  `,
};
