# v0.3.4 release and Bill dry run

Completed October 19, 2026 (America/New_York; October 20 UTC).
This log contains aggregates only. Mailbox content and detailed reports remain private.

## Release

- Commit: `770a550ac0721e78be2dc492697a4213582eb092`.
- Release: <https://github.com/unblocklabs-ai/gog-email-watch/releases/tag/v0.3.4>.
- CI passed: <https://github.com/unblocklabs-ai/gog-email-watch/actions/runs/39360331597>.
- Publication passed: <https://github.com/unblocklabs-ai/gog-email-watch/actions/runs/39360448357>.
- Local preflight: typecheck, build/schema, 43 behavioral tests, plugin inspector,
  real-SDK registration capture and package validation passed.
- Published npm artifact, local reproducible package and Bill's installed source
  all have the same integrity:
  `sha512-XwPYGFWm4GDdbZNXhB1YvrwUoNsHo367FmQsQAF1OIkhpwFXJ2E3hzewDISsTeJzKh5Nw9mk3GqGh5ff6A7cKA==`.

The release removes the 16,000-byte evidence truncation and classifies full
plaintext conversations once per thread. Labels remain a separate classification.
Message-level receipts and deletion eligibility remain intact.

## Bill installation and preservation

Installed the pinned npm release through the native OpenClaw installer with
`--force --accept-capabilities --no-enable`; applied in Gateway generation 21.
Live Gateway inspection reports v0.3.4. Its RPC probe passed without a restart.

Before installation, backed up the config, service definition and live SQLite
database. After installation, preview and failure diagnostics, verified:

- Plugin configuration and unrelated configuration unchanged.
- Service definition byte-for-byte unchanged.
- Every live mail database table unchanged.
- Watcher remains disabled; automatic deletion remains off.
- Queue interval remains 1,440 minutes; configured concurrency remains 50.

## Real-mailbox preview

The same 771-message cohort spans 495 Gmail threads. Fresh thread reads include
later sent replies. The released classifier was run against a private database
copy using Bill's existing Jev credential, with no agent runtime and throwing
mailbox-write methods. Independent label inference was not run.

| Scope | Threads | Skip | Queue | Wake | Failed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Entire comparison cohort | 495 | 420 | 49 | 22 | 4 |
| Threads containing unfinished mail | 445 | 385 | 41 | 15 | 4 |

The 15 unfinished wake conversations cover 17 unfinished messages and would
produce one immediate wake, not 15. Actual wakes and Gmail writes were zero.
Completed work was included only for comparison, not readmitted.

There were 495 classifier requests and 491 successful responses. Eighteen inputs
exceeded the former 16,000-byte evidence cap. The largest successful input was
27,431 tokens; successful inputs totaled 931,518 tokens. Peak observed classifier
concurrency was 44. This used the installed TypeSafe client directly, so it does
not validate the Gateway's separate Decisions admission cap or agent dispatch.

The preview's HTTP observer was bypassed by OpenClaw's runtime dispatcher. Its
original zero HTTP count is invalid instrumentation, not evidence of no requests.
The private human-readable report records that caveat.

## Remaining issues exposed by the preview

Four long conversations failed, covering 64 cohort messages (60 unfinished).
One targeted diagnostic replay per failed conversation confirmed HTTP 400 with
`{"detail":{"error_type":"max_tokens_exceeded"}}` from Jev. These are upstream
context-limit rejections, not transient network errors. Original failed outcomes
remain in the preview totals; no truncation, splitting or long-context override
was applied. Provider configuration was not changed.

The wake candidates still skew toward older account/security notices. Grouping
conversations and supplying full context does not establish that these notices
represent unresolved work. Tightening that distinction in the agent-configurable
prompt and evaluating the provider's long-context option are follow-ups, not
changes made during this rollout.

Private reports and backups are in Bill's `gog-v034-rollout-20261019` artifact
folder. No message subjects, IDs, bodies or credentials are committed here.
