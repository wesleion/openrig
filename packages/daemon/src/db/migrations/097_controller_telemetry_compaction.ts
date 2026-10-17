import type { Migration } from "../migrate.js";

export const controllerTelemetryCompactionSchema: Migration = {
  name: "097_controller_telemetry_compaction.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN controller_json TEXT;
    CREATE TABLE compaction_preparations (
      session_name TEXT NOT NULL, attempt_id TEXT PRIMARY KEY,
      occupant_generation TEXT, state_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX compaction_preparations_session ON compaction_preparations(session_name, updated_at);
    CREATE TABLE seat_activity_timing (
      seat_node_id TEXT PRIMARY KEY, generation TEXT NOT NULL, session_name TEXT NOT NULL,
      activity TEXT NOT NULL, activity_started_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `,
};
