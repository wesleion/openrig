import type { Migration } from "../migrate.js";

export const sessionRenewalSchema: Migration = {
  name: "098_session_renewal.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN session_renewal_json TEXT;
    ALTER TABLE nodes ADD COLUMN session_renewal_json TEXT;
    CREATE TABLE session_renewal_baselines (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      runtime TEXT NOT NULL, session_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL, inference_at TEXT NOT NULL,
      PRIMARY KEY (node_id, runtime, session_id)
    );
    CREATE TABLE session_renewals (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL, qitem_id TEXT NOT NULL,
      state TEXT NOT NULL, record_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (node_id, episode_id)
    );
    CREATE INDEX session_renewals_latest ON session_renewals(node_id, updated_at);
  `,
};
