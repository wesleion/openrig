import type { Migration } from "../migrate.js";

const fields = ["source_session", "destination_session", "state", "body", "summary", "human_questions", "human_answers", "human_intent", "human_detail", "evidence_ref", "target_repo", "expires_at", "blocked_on", "closure_reason"];
const payload = (p: string) => `json_object('qitemId', ${p}.qitem_id, 'sourceSession', ${p}.source_session,
  'destinationSession', ${p}.destination_session, 'state', ${p}.state, 'body', ${p}.body,
  'summary', ${p}.summary, 'humanQuestions', json(${p}.human_questions), 'humanAnswers', json(${p}.human_answers),
  'humanIntent', ${p}.human_intent, 'humanDetail', ${p}.human_detail, 'evidenceRef', ${p}.evidence_ref,
  'targetRepo', ${p}.target_repo, 'expiresAt', ${p}.expires_at, 'blockedOn', ${p}.blocked_on,
  'closureReason', ${p}.closure_reason, 'revision', ${p}.human_revision)`;

export const humanBridgeSchema: Migration = {
  name: "096_human_bridge.sql",
  sql: `
    ALTER TABLE queue_items ADD COLUMN human_revision INTEGER NOT NULL DEFAULT 1;
    CREATE TABLE human_bridge_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT, qitem_id TEXT NOT NULL,
      previous_destination_session TEXT,
      revision INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX human_bridge_events_item ON human_bridge_events(qitem_id, event_id);
    CREATE TABLE human_decisions (
      scope TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL,
      qitem_id TEXT NOT NULL, actor_session TEXT NOT NULL, input TEXT NOT NULL,
      state TEXT NOT NULL, result TEXT, PRIMARY KEY(scope, request_id)
    );
    CREATE TABLE human_bridge_dispatch (
      bridge_id TEXT NOT NULL, human_address TEXT NOT NULL, decision_id TEXT NOT NULL, event_id INTEGER NOT NULL,
      payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', receipt TEXT,
      PRIMARY KEY(bridge_id, decision_id)
    );
    CREATE TABLE human_bridge_receipt_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bridge_id TEXT NOT NULL, decision_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(bridge_id, decision_id, attempt_id, status)
    );
    CREATE TABLE human_bridge_creates (
      bridge_id TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL,
      qitem_id TEXT NOT NULL UNIQUE, result TEXT,
      PRIMARY KEY(bridge_id, request_id)
    );
    CREATE TABLE human_bridge_presence (
      bridge_id TEXT PRIMARY KEY, human_address TEXT NOT NULL, last_poll_at TEXT NOT NULL
    );
    CREATE TABLE human_bridge_native_dispatch (
      bridge_id TEXT NOT NULL, native_decision_id TEXT NOT NULL, decision_id TEXT NOT NULL,
      qitem_id TEXT NOT NULL, notification_key TEXT, acknowledged INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(bridge_id, native_decision_id)
    );
    CREATE TRIGGER human_bridge_insert AFTER INSERT ON queue_items BEGIN
      INSERT INTO human_bridge_events(qitem_id, revision, payload)
      VALUES(NEW.qitem_id, NEW.human_revision, ${payload("NEW")});
    END;
    CREATE TRIGGER human_bridge_update AFTER UPDATE ON queue_items
    WHEN ${fields.map(f => `OLD.${f} IS NOT NEW.${f}`).join(" OR ")}
    BEGIN
      UPDATE queue_items SET human_revision = OLD.human_revision + 1 WHERE qitem_id = NEW.qitem_id;
      INSERT INTO human_bridge_events(qitem_id, previous_destination_session, revision, payload)
      SELECT qitem_id, OLD.destination_session, human_revision, ${payload("queue_items")} FROM queue_items WHERE qitem_id = NEW.qitem_id;
    END;
    INSERT INTO human_bridge_events(qitem_id, revision, payload)
    SELECT qitem_id, human_revision, ${payload("queue_items")} FROM queue_items;
  `,
};
