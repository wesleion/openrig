/** Offline Claude captures: complete composer, running status and approval modal. */
export function claudeCompactionPane(state = "idle", staged = "", planMode = false): string {
  if (state === "unknown") return "Disconnected terminal; no current native composer.";
  if (state === "needs_input") return "Do you want to proceed?\n❯ 1. Yes\n  2. No";
  const status = state === "running" ? "✻ Thinking… (1s · ↓ 1 token)" : "✻ Worked for 1s";
  const mode = planMode ? "⏸ plan mode on (shift+tab to cycle)" : "⏵⏵ auto mode on (shift+tab to cycle)";
  return `${status}\n────────────────────\n❯ ${staged}\n────────────────────\n${mode}`;
}
