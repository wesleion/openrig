import type Database from "better-sqlite3";

/** Conversation history survives an account resume. Provider cache warmth does
 * not: only an inference observed after the binding epoch can warm that account.
 * Missing evidence remains unknown; it must never force a fresh conversation.
 */
export function accountScopedInferenceAt(db: Database.Database, nodeId: string, inferenceAt: string | null | undefined): string | null {
  if (!inferenceAt || !Number.isFinite(Date.parse(inferenceAt))) return null;
  let row: { changed_at: string } | undefined;
  try { row = db.prepare("SELECT changed_at FROM provider_account_bindings WHERE node_id=?").get(nodeId) as typeof row; }
  catch { return inferenceAt; } // schema fixtures and installations without multiconta
  return row && Date.parse(inferenceAt) < Date.parse(row.changed_at) ? null : inferenceAt;
}
