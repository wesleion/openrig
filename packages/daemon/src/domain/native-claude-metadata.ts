import { readTailLines } from "./model-divergence/effective-model-readers.js";
import type { ContextUsage } from "./types.js";

type Metadata = NonNullable<ContextUsage["runtimeMetadata"]>;
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Latest real response for this native session; bounded to 512 KiB, no message bodies escape. */
export function readClaudeRuntimeMetadata(transcriptPath: string | null | undefined, sessionId: string | null | undefined): Metadata | null {
  if (!transcriptPath || !sessionId) return null;
  const lines = readTailLines(transcriptPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes('"assistant"')) continue;
    try {
      const record = JSON.parse(lines[i]!);
      if (!record || record.type !== "assistant" || record.message?.role !== "assistant") continue;
      if ((record.sessionId ?? record.session_id) !== sessionId) continue;
      const model = text(record.message.model);
      if (!model || model === "<synthetic>") continue;
      const at = text(record.timestamp);
      return { model, effort: text(record.perTurnEffort) ?? text(record.effort),
        sampledAt: at && Number.isFinite(Date.parse(at)) ? at : null, source: "claude_transcript_jsonl" };
    } catch { /* A corrupt or truncated line cannot establish a model. */ }
  }
  return null;
}
