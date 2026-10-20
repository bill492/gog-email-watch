# Rolling inbox triage and token trimming

Date: 2026-10-19 (America/New_York).
Status: implementation and review fixes prepared for v0.3.5. The results below
precede release and rollout; deployment verification is recorded separately.

## Behavior

- Jev triages recent existing inbox mail and new arrivals, not only the initial backlog.
- `settings.maxAgeDays` defaults to 30 rolling days. Older messages skip in code,
  without inference. `null` disables the cutoff.
- The cutoff uses Gmail's timestamp per message. A new reply in an old thread is
  eligible; old messages remain context, not action targets.
- The cutoff is rechecked before wake dispatch and mailbox effects. A waiting
  queue can expire without another inference. Explicit historical deletion scans
  are exempt.
- Each conversation still receives one action classification. Independent labels
  remain separate. Completed work is not replayed.
- The default prompt prioritizes concrete work owed by the account. Copied
  conversations, resolved requests, routine notifications and expired invitations
  should skip. Non-urgent owned work queues; genuinely urgent owned work wakes.
- Existing custom prompts remain intact. Adopting the new default requires an
  explicit prompt update.

## Oversized conversations

New settings mirror Jev's documented default bounds:

| Setting | Default |
| --- | ---: |
| `maxInputTokens` | 32,000: state plus largest question |
| `maxRequestTokens` | 64,000: state plus all questions |

The plugin counts with `tiktoken` / `cl100k_base`. This is an estimate, not Jev's
tokenizer: Jev publishes neither its tokenizer nor a count endpoint.

Trimming drops oldest whole messages first. If the newest message alone is too
large, it retains the beginning at a Unicode-safe boundary. Policy and label
definitions are not truncated. Requests mark truncated evidence, and inspection
records incomplete coverage. Full agent transcript files remain unchanged.

The four conversations that previously returned HTTP 400
`max_tokens_exceeded` all returned HTTP 200 after trimming. Jev reported
26,392 / 29,080 / 26,484 / 30,574 input tokens; all four classified as skip.
They were explicitly tested outside normal age selection to exercise trimming.

This proves those failures are fixed, not that the estimate guarantees every
future input will fit. Upstream rejection remains visible and pending for retry.

## Real-mail prompt hill-climb

All runs used Bill's real Gmail threads and real Jev requests. State and config
were private copies; no synthetic mailbox was used. No BenchMax tool/CLI was
available, so this was a direct prompt comparison rather than a BenchMax run.

Original cohort: **771 messages in 495 conversations**.

- **660 messages** excluded by age before Jev.
- **111 messages in 79 conversations** eligible for inference.
- Of the original 71 queue/wake conversations, 46 were wholly outside the age
  window and 25 remained recent.

| Prompt candidate, with age gate | Skip conversations | Queue | Wake | Errors |
| --- | ---: | ---: | ---: | ---: |
| Existing policy | 469 | 17 | 9 | 0 |
| `current_work` | 492 | 3 | 0 | 0 |
| `actionable_now` | 479 | 16 | 0 | 0 |
| `owned_action` | 490 | 5 | 0 | 0 |
| Final default verification | 490 | 5 | 0 | 0 |

The most aggressive candidate was rejected: it missed four of five identified
tasks and queued two copied/waiting-on-others conversations. The winner retained
pending account configuration, approvals and an invitation, while skipping
routine security notices, bot chatter, resolved/copied chains and expired requests.

The **71 previously queued/waking conversations became 66 skip, 5 queue, 0 wake**.
One of those five queues was already completed in live state; this comparison
deliberately included completed work to compare classifiers.

These are iterative results on the tuning cohort, not held-out accuracy scores.
There were no clear current urgent-positive examples, so zero wakes does not
establish urgent-mail recall.

## Actual workflow dry run

Ran `createMailWorkflow` against fresh real Gmail discovery/reads, real Jev and a
copy of Bill's live SQLite state:

| Outcome | Messages |
| --- | ---: |
| Already completed, preserved | 70 |
| Skipped | 697 |
| Queued | 4 |
| Pending / errors | 0 |

**69 Jev calls; 0 projected jobs during the run; 0 actual wakes; 0 mailbox writes.**
The four queued items can wake together at their configured queue interval; zero
jobs during this dry run does not mean queued mail will never wake.

Mailbox mutation/send adapters rejected writes; the subagent adapter captured
hypothetical jobs without invoking the Gateway agent runtime. Labels were disabled
only in the copied config. Therefore this run validates action triage, not live
label application or the host's wake delivery.

Bill's installed 0.3.4 remained paused, deletion remained off, and live config,
service definition and SQLite state were verified unchanged.

## Validation and scope

- Full preflight passed on Node 24.21.0: typecheck, build/manifest synchronization,
  **45 passing tests**, static plugin inspection, real-SDK registration capture and
  package preview. `git diff --check` passed.
- Static inspection reported no live compatibility issues; its two generic proof
  gaps concern isolated dependency installation and registrar capture. Real-SDK
  capture ran separately; this is not proof of deployment into Bill's Gateway.
- Rolling-lifecycle regression fails on the prior implementation because old mail
  reaches inference. It covers new external replies, one combined wake, restart
  deduplication, queue expiry and the configurable age override.
- Oversized-evidence workflow checks retained recent plaintext, truncation
  visibility and intact agent transcripts; the four real upstream failures above
  provide the before/after provider proof.
- Final review found a delayed-label expiry race. Its workflow regression first
  reproduced a mailbox write after expiry; the fix checks age immediately before
  the effect. This edge case is tested locally; labels were disabled in the
  real-mail dry run.
- No additional permission gates, attempt caps, throughput quotas or budget caps.
- OpenClaw plugin skills guided compatibility/packaging checks; test-audit guided
  behavioral tests at the workflow boundary rather than implementation assertions.
- Before subsequent review fixes: +72 lines across production TypeScript;
  +44 lines in tests.

## Subsequent code-review fixes

Three reproduced findings were fixed without changing Bill's installed plugin:

1. A newly discovered reply now reconciles waiting members of the same conversation,
   including a wake reserved behind another agent job. Completed/running work stays
   untouched. The regression failed before the fix; additional scenarios cover an
   already-due queue and an urgent-to-queue downgrade.
2. File-policy fingerprints now represent an explicit file choice, not the built-in
   default. Upgrades with no file policy preserve the saved prompt, queue interval,
   deletion instructions and labels. An explicit file edit can still replace them.
   The migration regression failed before the fix.
3. Trimming searches for the retained message suffix instead of re-tokenizing every
   remaining suffix. A warmed, local 100-message / 1.95 MB plaintext benchmark fell
   from **10,650 ms to 551 ms** (about **19× faster**). The 20-message case fell from
   424 ms to 163 ms. These are local measurements, not guaranteed latency bounds.

No new processing limits, worker framework or production-only test hooks were added.
The prior real-mail results above are not a new live rollout of these review fixes.

The full preflight after these fixes passed: **51 tests, zero failures**, typecheck,
build/manifest, static inspection, real-SDK registration capture and package preview.
The static inspector retains the same two generic proof gaps noted above.
The three fixes add a net 17 production lines and 92 workflow-test lines relative
to the reviewed implementation. No deployment was performed during these checks.

Private mail IDs, subjects, bodies and raw benchmark artifacts are intentionally
excluded from this repository report.
