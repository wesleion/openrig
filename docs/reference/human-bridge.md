# HTTP human bridge

The HTTP pull connector exposes native human decisions without a platform-specific webhook. Register a human with one primary `hermes` connector binding, including its platform user handle. Configure the bridge explicitly with `rig bridge configure --config-file <json> --token-file <private-file>`. The configuration stores a SHA-256 hash, never the bearer value. Registration and enabling are separate operator actions.

Every bridge request uses `Authorization: Bearer <bridge-token>`. The credential determines the human identity; body fields and `X-OpenRig-Session` cannot replace it. A bridge can only use its declared `inbox`, `receipts`, `answer` and `create` scopes. Queue creation additionally requires an exact destination allowlist. A bridge cannot update arbitrary queue state, register humans, change configuration, reconcile deliveries, or forward writes to another host.

## Configuration

The JSON configuration contains `id`, `enabled`, `humanAddress`, `legacyAliases`, `scopes`, `allowedDestinations` and `origins`. `origins` maps a rig name to `{projectId, projectName}`. `tokenSha256` is computed by the configure command. Only `human@kernel` is accepted as an explicit legacy alias; no alias is inferred. Existing queue items retain their IDs and addresses. Changing a bridge's registered human prevents access to the prior human's dispatch records.

## Inbox

`GET /api/bridge/inbox` returns an authoritative snapshot. Subsequent requests use `?cursor=<last-cursor>` and receive the coalesced latest changes. Persist the cursor only after durably applying the response. On `409 cursor_ahead`, obtain a new snapshot and reconcile locally stored cards.

The response contains `snapshot`, `cursor`, `events` and `pending`. An event includes `eventId`, stable `decisionId`, `type`, `deliveryStatus`, `retryAllowed`, `message` and `qitem`. `message` contains the last reported `{chatId, messageId}` for that queue item, or null. Delivery coordinates let a restarted bridge edit an existing card rather than create another one.

The queue item includes `qitemId`, `sourceSession`, `destinationSession`, `state`, `body`, `summary`, `humanQuestions`, `humanAnswers`, `humanIntent`, `humanDetail`, `evidenceRef`, `targetRepo`, `revision` and `origin`. Origin includes `rigId`, configured `projectId` and `projectName`; unavailable identity fields are null. `humanIntent` is `decision` or `update`. Structured questions retain their original question and option IDs.

Event types are `created`, `revised`, `resolved`, `canceled`, `expired` and `withdrawn`. Resolution through another channel is visible through the same queue state history. Withdrawn events contain only the previously visible queue item ID and revision; they never expose a new recipient's content. A snapshot with no item removes that item's current card from the local active view. `pending` is the durable delivery ledger and must also be processed after restart; polling does not acknowledge a delivery.

## Delivery receipts

Before a Telegram operation, `POST /api/bridge/receipts` with `{decisionId, attemptId, status:"attempting"}`. Send only when the response says `sendAllowed:true`. Persist the attempt ID before reserving. Repeating a reservation never authorizes another send. A stale queue revision refuses the reservation and requests another poll.

After the operation, report the same attempt ID with `status:"delivered"`, `"failed"` or `"indeterminate"`. Successful delivery requires string `chatId` and `messageId`. `failed` means a definite failure before acceptance and permits a new attempt ID. A timeout, lost response or crash after reservation is indeterminate. Do not retry such an operation automatically: Telegram `sendMessage` is not idempotent. An unresolved older attempt also holds newer revisions of the same card.

An operator can reconcile through `POST /api/bridge-admin/:bridgeId/reconcile` or `rig bridge reconcile <bridgeId> <decisionId> --request-id <id> --action confirm|retry`. Confirmation requires message coordinates. Explicit retry acknowledges that a duplicate Telegram message is possible. The bridge credential cannot perform this operation. Reconciliation and receipts are durable and idempotent; conflicting reuse of an ID returns 409.

## Human answers

`POST /api/queue/:qitemId/answer` accepts `{requestId, expectedRevision, answers:{questionId:optionId}}` for structured decisions, or `{requestId, expectedRevision, decision:"text"}` for a free-text decision. The CLI equivalent is `rig queue answer <qitemId> --question <questionId> --option <optionId> --request-id <id> --expected-revision <n> --json`, or `--decision-file <json>`. A local operator can specify `actorSession` in that file when no transport identity is supplied. Prefer an environment credential over putting bearer values in shell history.

Partial answers update native `humanAnswers` and keep the question open. A complete answer records its durable intent, creates one stable continuation item, and uses the existing Mission Control human reply resolver. An interrupted finalization is retryable with the exact original request and is recovered after daemon restart. Closed, canceled, stale, foreign-human or invalid-option requests are refused. Reusing a request ID with another payload returns 409.

For newly authored choice decisions, use `rig queue create ... --human-questions-file <json>`. Body text such as `Opções:` is not a structured question schema. Legacy free-text items remain free-text decisions and do not acquire fabricated IDs.

Slack buttons and free-text decisions use this same service. Free text on a structured Slack decision teaches the user to use its question buttons and leaves the decision open.

## Task creation and identity

`POST /api/queue/create`, or `rig bridge create --request-file <json>`, supports a stable `qitemId` and `requestId`. The credential supplies the human source. Retrying the same request returns the original result; changing its content or reusing another item's ID returns 409. Only configured destinations are admitted. A Telegram text/audio message ID is a suitable retry identity. For buttons, a step suffix must distinguish actual callback actions, not merely the question ID.

The Hermes plugin must verify the Telegram sender against the registered platform user before using its credential. Native HTTP authorization authenticates the bridge credential; it cannot independently inspect Telegram's update authenticity. Do not accept a human identity asserted in arbitrary message text.

## Readiness and network boundary

`GET /api/gateway/human/:entityId/readiness` reports Hermes separately from Slack: missing/disabled/stale polling is `not-ready`; active polling without a reported delivery is `indeterminate`; polling within 90 seconds plus delivery evidence is `ready`. This does not substitute for a real Telegram acceptance test.

All non-loopback mutations and terminal WebSocket upgrades require a credential. The socket peer establishes loopback status; Host, forwarded headers and session claims cannot do so. Operator bearer credentials permit general writes. Native terminal and activity-hook credentials retain their narrower routes. Bridge credentials remain scoped even on loopback. Explicit non-loopback binds require an operator bearer token at startup. Keep `daemon.host=127.0.0.1` until remote credentials are configured.

## Acceptance boundary

The registered human's primary binding selects outbound transport. A Hermes primary binding never posts to Slack. Native gateway notifications enter the same durable HTTP mailbox; polling alone does not acknowledge them. A confirmed delivery receipt drains the native dispatch buffer and records its owner notification receipt. Restart recovery completes acknowledgements committed before a process exit. A newer confirmed card can retire obsolete, unattempted notifications with a separate superseded disposition, without fabricating older delivery receipts.

Items authored by the registered human and assigned to an allowed agent are visible as status updates with the destination rig as their origin. Delivery does not close agent tasks. An explicit informational item addressed to the human closes only after its delivery receipt. Genuine decision items remain open until a human answer.

After enabling or disabling a bridge configuration, restart the daemon to refresh advertised gateway capabilities. This does not require restarting agent sessions.

The implementation provides native storage, HTTP transport, event history, answers, receipts and connector readiness. A running daemon alone does not prove the Hermes plugin is consuming this contract. Verify request creation, structured partial/final answers, another-channel closure, daemon/plugin restart, stale revision rejection, and an indeterminate Telegram send with the real integration before claiming end-to-end readiness.
