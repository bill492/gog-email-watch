# v0.3.3 release and Bill no-wake preview

## Release and validation

- Feature commit: `dc677deb806500fbb40622360b886fee049c8a6d`.
- Tagged release commit: `dad9b391868e14cb3b09ccd116d0253ebd6ebe53`.
- [GitHub release](https://github.com/unblocklabs-ai/gog-email-watch/releases/tag/v0.3.3).
- [CI passed](https://github.com/unblocklabs-ai/gog-email-watch/actions/runs/39355534958).
- [Release workflow passed](https://github.com/unblocklabs-ai/gog-email-watch/actions/runs/39355681141).
- npm `latest` verified as `0.3.3`. Downloaded archive integrity and SLSA
  provenance subject/source commit match the tagged release.
- Full preflight: 41 behavioral tests, typecheck, build/schema alignment, static
  plugin inspection, real-SDK registration capture and package validation passed.
  Static inspection retains its two previously documented proof gaps.

The first CI attempt exposed an existing test-fixture race: incoming mail was
created before watcher activation and could cross the activation second. The
test also leaked its polling timer on failure. A controlled-clock reproduction
failed for that reason; creating incoming mail after startup and using finally
cleanup repaired the fixture without changing production behavior or weakening
duplicate-delivery/restart assertions.

The initial local pack used Node 22 and had different compressed bytes from CI.
Packing with CI's exact Node 24.21.0/npm 11.13.0 versions reproduced the published
archive exactly: SHA-1 `e4a35f04a846c395bf3991b69e984bacab896ed2`.

## Installation and preservation

Bill was updated through the native installer to pinned npm v0.3.3 with
`--no-enable`, applied in Gateway generation 20. Live Gateway inspection confirmed
the package version, exact npm spec and published integrity. The watcher remains
disabled deliberately; the running Gateway process was not restarted.

The only intended watcher configuration changes were pausing it and updating its
custom action prompt to use skip and distinguish current unresolved work from
resolved, expired and informational mail. Automatic deletion remains off;
queue interval remains 1,440 minutes; concurrency remains 50; approved senders,
external-reply setting and label definitions are preserved.

Post-preview assertions compared all live mail database tables against the
pre-preview snapshot, unrelated config against its backup, and service-definition
bytes against the saved plist. All matched. No completed job was reset or replayed.

## Real-mailbox preview

The published v0.3.3 classifier ran against all 771 inbox backlog messages using
isolated SQLite state and Bill's existing Jev credential. Each request included
sent-date evidence and the current date in America/New_York. The run completed
from 2026-10-20 01:55:34 UTC to 01:55:58 UTC (October 19 locally).

| Scope | Skip | Queue | Wake |
| --- | ---: | ---: | ---: |
| All 771 messages, freshly classified | 708 | 52 | 11 |
| 701 messages not already completed in live history | 647 | 46 | 8 |
| Original 52-message queue-wake comparison | 48 | 4 | 0 |

The comparison overlaps the first row. All original 52 are already completed in
live history; their four new queue classifications do not imply replay on resume.
Of the eleven fresh wake classifications, three likewise belong to completed
jobs. A fully successful cycle for the unfinished backlog would consolidate the
remaining eight into one immediate wake. The 46 queued messages were not due
at preview time; their projected next queue wake, using preserved live timestamps,
is 2026-10-21 01:19:49 UTC (October 20, 9:19:49 PM America/New_York).

- 771 real Jev calls; zero errors; observed peak concurrency 46 with 50 workers.
- Zero actual agent wakes, Gmail mutations or live mail database writes.
- Automatic deletion remained disabled; labels were not inferred or applied.
- 180 assessments used configured trimmed excerpts. 206 reported missing inline
  evidence categories, such as unscanned attachments or unsupported MIME parts.
  These groups can overlap; no claim is made that attachment contents were read.

This was an action-only operational preview, not a newly shipped dry-run command
or a live scheduler run. It imported the published classifier and installed
TypeSafe client directly, omitted the agent-dispatch path, and made every exposed
Gmail-write method throw. It did not use deletion scans or replace live state.

The live Gateway's separate hard-coded four-call Decisions admission limit remains
unfixed. This direct-client preview demonstrates Jev classification, not production
Gateway throughput; live overload retries can split work across polling cycles.

## Assessment and next step

Skip substantially reduced attention demand, especially for the original 52.
The remaining wake list is dominated by older account/security notifications;
that is not evidence that those messages require an email reply. Classification
quality should be reviewed before resuming automatic wakes. No additional prompt
tuning or automatic re-enablement was performed after seeing these results.

Private per-email results, sent dates, original-52 comparison, evidence coverage
and preserved-state projection are saved on Bill. A private Markdown copy was
provided locally for review. No email subjects, senders, message IDs, bodies,
credentials or private detailed report were added to this public repository.
