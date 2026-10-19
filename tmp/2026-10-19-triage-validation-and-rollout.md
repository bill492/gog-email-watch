# Inbox triage v0.2.1: validation and rollout

Implementation commit: `6ddd2610854e24427a0f1569000771aa241f12c5`.
Canonical agent-config fix: `7efbde7089bf5b6008115642efe816e8ab8e579e`.
Plan: [review and implementation plan](2026-10-19-inbox-triage-review-and-plan.md).

## Implementation and code review

- Kept one polling service, one agent worker and the existing SQLite history.
- Seven runtime modules; reused OpenClaw Decisions rather than adding provider transport.
- Self-review fixed discovery watermarks, uncertain-effect reconciliation, assessment
  refresh history and default destination authority. Removed an unused wrapper/import.
- Full preflight passed: 22 behavioral tests, typecheck/build/schema, static inspector,
  actual SDK registration, package dry run, release-version check and diff check.
- CI passed: https://github.com/unblocklabs-ai/gog-email-watch/actions/runs/39317841442.
- v0.2.1 CI passed: https://github.com/unblocklabs-ai/gog-email-watch/actions/runs/39319415317.
- Bill's canonical `agents.entries` config exposed a manual `agents.list` lookup
  mismatch. The added service-boundary regression failed before the fix and passed
  after switching to the host SDK's `resolveAgentConfig`. No replacement config
  resolver or compatibility framework was added.

## Bill: real mailbox verification

Used Bill's existing gog account and Jev credential, without copying secrets. An
isolated OpenClaw 2026.9.9 Gateway ran the exact candidate artifact in shadow mode;
the existing live responder remained unchanged during validation.

The bounded seven-day inbox query returned **34 messages**, with no additional
search page. The real Decisions runtime returned **33 successful Jev 1.13.0
assessments**; one message had incomplete evidence and was retained without inference.

| Proposed handling | Count |
| --- | ---: |
| Retain for digest | 25 |
| Retain for review | 8 |
| Trash proposal, review only | 1 |
| Archive proposal | 0 |

Review holds: six protected-content checks, one incomplete-evidence hold and one
credential-fraud flag. These are classifier proposals, not human-confirmed truth
or calibrated accuracy measurements.

The real-mail validation database contained **zero effects, zero jobs and zero
reply attempts**. No real messages were moved, labeled or sent by the canary.
Both review CLI commands were exercised through the Gateway RPC. Private JSON
reports, with message IDs/Gmail links, remain on Bill under:

`/Users/billjohansson/.openclaw-gog-triage-canary-20261019/`

- `real-scan-50.json`
- `real-review-all.json`
- `real-archive-review.json`
- `real-trash-review.json`

The earlier isolated synthetic test additionally exercised malicious content,
attachments, wake-up dispatch and completion through the real Gateway/Jev runtime.
It used a controlled conversation model and did not prove Bill's ordinary model
completes a natural email job. The real-inbox scan above does not replay old mail.

The two isolated validation processes have been stopped; their private artifacts
are retained. Bill's normal Gateway was not stopped during validation.

## Release and rollout status (pending two approvals)

- GitHub release/tag: https://github.com/unblocklabs-ai/gog-email-watch/releases/tag/v0.2.1.
  The v0.2.0 tag remains unchanged and is marked superseded; neither version has
  successfully published to npm yet.
- npm's OIDC token exchange returns `404: package not found`, although normal
  registry lookup works and the authenticated trust listing matches this repository
  and `release.yml`. Publication retries failed. The latest failure is
  https://github.com/unblocklabs-ai/gog-email-watch/actions/runs/39319584439.
  Asked permission to recreate the exact trust entry, preserving existing permissions.
- Bill has the exact v0.2.1 archive installed, SHA-1
  `c7098b32eda33eede735be231cd179d485046bc0`, and official TypeSafe 2026.9.9 installed.
  Runtime plugin replacement succeeded without restarting the Gateway.
- Live Jev activation is **not operational**: the provider reports
  `credentialReady: false`, and the live scan returned 33 `credentials-unavailable`
  results plus one already-tracked message. No mail effects occurred. This failed
  scan is not the successful isolated real-mail validation above.
- Configuration validation passed, and secrets reload completed with one existing
  inactive OpenRouter-profile warning. Reloading TypeSafe did not resolve readiness.
  The existing key worked in the clean-started isolated Gateway. A clean live
  restart is the next step, not a claim that the cause is conclusively established.
- Cooperative suspension repeatedly reports one persistent `cron:timer-tick`
  request; no running cron jobs or active agent turns were reported. No forced
  restart was performed. The temporary suspension was released. Restart approval
  was requested explicitly to acknowledge that housekeeping request.
- **Original approved-sender behavior was restored by removing triage config**
  while activation is blocked. Provider setup and per-agent decision-model selection
  remain staged; the conversation model is unchanged. Once Jev readiness is proven,
  restore live/approved triage with label/wake/digest and archive/trash review-only.
- Before rollback, a guarded comparison verified all unrelated configuration,
  sender rules, default agent settings, the memory plugin, LaunchAgent bytes,
  activation cutoff and existing message IDs were preserved. A fresh successful
  poll had no error. Existing history remained 4 done/6 ignored messages and 4
  skipped jobs. Gateway PID remained 50694 and RPC was healthy.

Private live-attempt artifacts also remain on Bill: `live-v021-review-scan.json`,
`live-v021-archive-review.json`, `live-v021-trash-review.json`, and
`typesafe-live-inspect.json`. Mail metadata and credentials are not committed here.

## Boundaries

Attachments are not scanned. Incomplete evidence stays held. Default thresholds
are conservative examples, not measured error guarantees. OpenAI Decisions is not
claimed tested on the released host; this delivery uses its supported V1 Jev adapter.
No auto-trash, permanent deletion, historical dispatch or fleet-wide rollout.
