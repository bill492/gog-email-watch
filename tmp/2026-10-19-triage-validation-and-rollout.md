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

## Release and rollout status

- GitHub release/tag: https://github.com/unblocklabs-ai/gog-email-watch/releases/tag/v0.2.1.
  The v0.2.0 tag remains unchanged and is marked superseded; it was not published
  to npm. The v0.2.1 tag points to the canonical agent-config fix above.
- npm initially rejected OIDC with `404: package not found`. With explicit owner
  approval, revoked and recreated only this package's exact trusted-publisher entry:
  `unblocklabs-ai/gog-email-watch`, workflow `release.yml`, preserving both publish
  and stage-publish permissions. The retried release workflow passed:
  https://github.com/unblocklabs-ai/gog-email-watch/actions/runs/39319584439.
  OIDC exchange returned 201; npm accepted publication with HTTP 202 on
  2026-10-19 at 20:37:28 UTC. Public registry availability subsequently confirmed.
  Signed provenance: https://search.sigstore.dev/?logIndex=3326183893.
  The registry's SHA-512 integrity matches the tested archive exactly. Its published
  SLSA statement identifies this repository, `release.yml`, tag `v0.2.1`, commit
  `7efbde7089bf5b6008115642efe816e8ab8e579e`, and release-run attempt 2.
- Bill initially used the exact v0.2.1 archive, SHA-1
  `c7098b32eda33eede735be231cd179d485046bc0`, then switched to the pinned published
  npm package after registry availability. Live inspection confirms npm source
  `@unblocklabs/gog-email-watch@0.2.1`, matching SHA-512 integrity, active watcher
  and official TypeSafe 2026.9.9, with no runtime diagnostics. This final replacement
  activated in Gateway generation 4 without another restart.
- The initial live scan failed with 33 `credentials-unavailable` results and one
  already-tracked message. Hot replacement and secrets reload did not activate the
  provider, so triage was temporarily removed to preserve original responder behavior.
  No mail effects occurred. These failed results are not the successful scans.
- With explicit approval, restarted Bill's Gateway after refreshing the safety
  check: only the persistent `cron:timer-tick` request remained; no agent runs,
  cron runs, queued work or pending replies were reported. The native restart
  initially refused an unknown owner lease: its recorded hostname lacked the
  current `.local` suffix. The supported authenticated restart RPC then performed
  a full process restart without changing the service definition. No core patch,
  state-lease edits or service reinstall were needed.
- Gateway PID changed from 50694 to 46873; RPC became healthy with a new boot ID.
  The live TypeSafe provider now reports `credentialReady: true` and `callable: true`.
  Its protected SecretRef still reads the existing key file; no credential was copied.
- **Live approved-sender triage is enabled** with label/wake/digest permissions.
  Archive/trash remains review-only. Configuration validation passed. A guarded
  comparison verified all unrelated configuration, sender rules, conversation-model
  settings, memory-plugin configuration, LaunchAgent bytes, activation cutoff and
  existing message IDs were preserved. A fresh scheduled poll completed without error.
- A second, successful scan through Bill's normal live Gateway examined 34 inbox
  messages: 33 successful `typesafe/jev-1.13.0` assessments, plus one already-tracked
  message left alone. Proposed handling: 25 retain/digest, 7 retain/review (six
  protected-content holds and one credential-fraud flag), 1 review-only trash,
  0 archive. Both real review CLI commands were exercised again.
- The successful live scan created zero effects or jobs. Existing history remains
  4 done/6 ignored messages and 4 skipped jobs. No test mail was sent, no historical
  work was dispatched, and no real mail was archived or trashed.

Private live-attempt artifacts also remain on Bill: `live-v021-review-scan.json`,
`live-v021-archive-review.json`, `live-v021-trash-review.json`, and
`typesafe-live-inspect.json`. Successful live evidence is stored separately:
`live-v021-post-restart-scan.json`, `live-v021-post-restart-archive-review.json`,
`live-v021-post-restart-trash-review.json`, `typesafe-live-final.json`, and
`post-restart-status.json`. Final npm-source checks are in `plugins-npm-final.json`,
`watcher-npm-final.json`, `typesafe-npm-final.json`, `npm-trash-review.json`, and
`post-npm-status.json`. Mail metadata and credentials are not committed here.

## Boundaries

Attachments are not scanned. Incomplete evidence stays held. Default thresholds
are conservative examples, not measured error guarantees. OpenAI Decisions is not
claimed tested on the released host; this delivery uses its supported V1 Jev adapter.
No auto-trash, permanent deletion, historical dispatch or fleet-wide rollout.
