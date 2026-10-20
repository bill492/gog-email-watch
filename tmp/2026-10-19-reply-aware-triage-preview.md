# Reply-aware triage implementation and Bill preview

Unreleased changes on top of v0.3.3. No commit, publication, live install change or
watcher re-enablement was performed for this follow-up.

## Implementation

- Action evidence includes latest sender/date/self identity, later-message and
  later-self-reply counts, and latest self-sent date, computed from the full thread.
- Drafts are excluded from those facts and the excerpt. The target and most recent
  other sent message share excerpt space; remaining room includes older context.
- Immediately before wake dispatch, fetch current threads. Reuse unchanged
  decisions; reassess changed threads and refresh the conversation transcript.
  Resolved or out-of-scope messages leave the wake; urgent items can return to queue.
- Reuse existing classification/effect handling. Failed refreshes retain their due
  wake intent; downgraded items preserve reservation lineage for later delivery.
  Completed/running agent work is not replayed. No new polling inference loop,
  review state, concurrency restriction or budget was introduced.
- README documents facts, excerpt allocation and pre-wake refresh behavior.

## Validation

Full preflight passed with 43 behavioral tests, typecheck, build/schema checks,
static plugin inspection, real-SDK registration capture and package validation.
The test-audit skill guided two new workflow-boundary regressions and extensions
of existing lifecycle cases; no standalone unit tests or test-only production
exports were added. Before-fix runs reproduced a hidden later reply, stale wake
membership, delayed retry and duplicate reservation ID. All pass after repair.

The classifier was staged separately on Bill with existing dependency resolution
and Jev credentials, not installed over the published plugin. All 771 IDs came
from the previous preview, with fresh Gmail thread reads and isolated state.
The final follow-up edits after this inference run concern scheduler bookkeeping,
not the classifier, evidence or prompt that produced these results.

| Scope | Skip | Queue | Wake |
| --- | ---: | ---: | ---: |
| Same 771 messages | 696 | 62 | 13 |
| 701 not already completed | 638 | 52 | 11 |
| Original 52-message comparison | 47 | 5 | 0 |
| 268 with newer sent messages | 243 | 25 | 0 |
| 35 with later self replies | 35 | 0 | 0 |

These subsets overlap. All 771 were assessed by Jev; later replies inform the
decision rather than causing a hard-coded exclusion. There were 771 real requests,
zero errors, observed peak concurrency 47, and zero actual wakes or mailbox writes.
Labels were not rerun and deletion remained off. The active Gateway's separate
concurrency limitation was not changed or exercised by this direct-client preview.

Attention candidates increased from 63 to 75 across the full cohort. This change
improves reply visibility and wake freshness; it does not prove quieter overall
classification. Old account/security notifications still warrant prompt tuning.

The live database tables, config bytes and Gateway service definition were compared
against the pre-preview snapshot and remained unchanged. The Gateway process stayed
running and the watcher stayed disabled. Detailed private reports remain on Bill
and were provided locally; no private subjects, senders, IDs or bodies are included
here. Release and activation remain separate follow-up actions.
