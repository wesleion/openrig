# Renewing a session before queue delivery

Session renewal is an opt-in daemon policy. It runs before the shared queue wake send, including initial creation, handoff and recovery wakes. Hermes and other human bridges do not need operator credentials to use or observe it.

Declare `session_renewal` at the RigSpec root or on a pod member:

```yaml
session_renewal:
  enabled: true
  cacheTtlMinutes: 60
  usedTokensMargin: 30000
```

Member fields override the rig fields. Omitted settings default to disabled, 60 minutes and 30,000 tokens. The TTL and margin must be positive integers.

A session is eligible when its last inference is older than the TTL and its input context has grown beyond the margin above its baseline. These are strict comparisons. Cache warmth is a time-based estimate, not provider confirmation or a savings guarantee. Claude input includes uncached input, cache reads and cache creation. Codex input already includes cache reads. Accumulated billing tokens are never the context-size measure; percentage of the context window is an estimated fallback.

The baseline is the first provable native inference after startup. It is persisted by node, runtime and native session ID. Historical inference records are read from the start of the native transcript with a 2 MB bound. An unreadable, truncated-before-the-needed-record, malformed or mismatched transcript does not become a zero or a latest-sample baseline. Missing baseline means no automatic renewal.

Renewal requires a ready, positively idle Claude or Codex seat without typing protection or in-progress work. Activity and generation are checked again under the existing lifecycle lease immediately before replacement. New work uses `fresh`; human continuation or a lineage the same chair worked on uses `rebuild`. Missing lineage evidence skips renewal.

The operation is recorded before replacement. Its key is the queue item, destination node and originating pending transition/human answer. Retries and daemon restarts never repeat a replacement for that episode. A subsequent human answer starts another delivery episode and can be evaluated again.

After a replacement attempt, delivery requires a live process whose carried node/session/generation identity agrees with the registry. An unchanged, confirmed predecessor remains a valid fallback. If no occupant is confirmed, the work stays pending and a deduplicated human decision item is created. Recovery never blindly retries an uncertain replacement.

`GET /api/rigs/:rigId/nodes` exposes `contextUsage.baselineInputTokens`, `contextUsage.contextInputTokens`, `contextUsage.contextInputSource`, `cache: {idleMinutes, warmEstimate}` and `renewal: {policy, last}`. The persistent renewal ledger and `seat.session_renewal` events distinguish `renewed-before-delivery`, `renewal-skipped:<reason>` and `renewal-failed`. Human bridge write permissions are unchanged.
