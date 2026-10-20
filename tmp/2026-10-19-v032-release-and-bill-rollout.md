# v0.3.2 release and Bill rollout

## Release

- Main feature/refactor and test-audit commit: `ef21c98ac0fbedf8fe4b0ee8c9a529c75e44bb08`.
- Gmail discovery fix and v0.3.1: `d7a6f1a15004cea22d4e7b369ccfe6b1bbaf83cd`.
- Non-blocking startup fix and v0.3.2: `35b892cd4d8a15969d3f0c257e91add9f561ab37`.
- [Release](https://github.com/unblocklabs-ai/gog-email-watch/releases/tag/v0.3.2).
- v0.3.2 [CI passed](https://github.com/unblocklabs-ai/gog-email-watch/actions/runs/39352707121)
  and [release workflow passed](https://github.com/unblocklabs-ai/gog-email-watch/actions/runs/39352807346).
- Public npm `latest` is v0.3.2. Downloaded archive SHA-512 and published SLSA
  provenance match the tested local package and commit `35b892c` exactly.
- v0.3.1 [CI](https://github.com/unblocklabs-ai/gog-email-watch/actions/runs/39351095357)
  and [release workflow](https://github.com/unblocklabs-ai/gog-email-watch/actions/runs/39351213599) passed.
- Full preflight passed, including 40 behavioral tests, typecheck/build, manifest,
  static/runtime plugin inspection, and package validation. The prior test audit
  removed the standalone unit-test file and detected all 14 isolated behavior
  mutations it exercised.

## Real-mailbox discovery regression

Initial v0.3.0 deployment exposed Gmail interpreting `after:0` as an empty result
for Bill's inbox. Removing only that token returned the real backlog. The existing
large-backlog workflow regression now checks the actual gog search arguments; it
failed before the fix and passed afterward. Positive-date searches are unchanged.

The initial inventory found 771 messages across 495 threads and eight pages.
The empty v0.3.0 discovery produced no new jobs or mail effects. During patching,
only the email watcher was paused; the Gateway and other plugins remained running.
Recovery clears only the exact empty-discovery marker, preserving the original
activation and triage cutoffs, prior jobs, messages, and reply receipts.

## Gateway startup regression

v0.3.1 discovered all 771 inbox messages (four already completed, 767 pending),
but waiting for that work inside service startup exceeded OpenClaw's five-second
hot-activation deadline. The host retired the candidate before it could use Jev;
pending messages retained their retry state and no new effects or wakes occurred.

v0.3.2 returns from plugin service startup while the existing asynchronous workflow
runs in the background. The existing service-boundary test now holds inference
open and verifies activation can finish independently. It demonstrably failed
before this one-net-line production fix and passed afterward. No new production
test seam or unit test was introduced. Full preflight passed again with 40 tests.

v0.3.1's public npm archive took approximately twelve minutes to become available
after acceptance. Its registry integrity, downloaded bytes, and provenance all
matched the local build and exact tagged commit. Bill was pinned to that npm
version before activation; older release tags were not moved.

## Bill configuration

- Existing account, approved-sender rules, credentials, and agent model preserved.
- `settings.concurrency: 50`; independent label processing enabled.
- Queued-mail wake interval: 1,440 minutes (one day), preserving his prior setting.
- `wakeOnExternalReplies: false`, preserving the existing boundary for new mail.
- `deletePrompt: ""`: **automatic deletion disabled**, as explicitly requested.
- Five independent label definitions: action, conversation, marketing, newsletter,
  and information. Action prompt considers thread history and completed requests.
- Existing mail state, config, and Gateway service definition backed up on Bill.

## Live verification

Pinned npm v0.3.2 was confirmed active in the live Gateway at generation 17, with
the Jev provider credential-ready and callable. Subsequent real mailbox polls
produced successful Jev classifications and confirmed independent Gmail labels.
The recovered 52-message queue job completed; all 52 had been classified queue,
not urgent wake. Its completion record reported no external actions. Subsequent
consolidated jobs also completed without replaying those messages.

At the next rollout's observation, the 771 tracked messages were 70 done,
359 pending and 342 queued. There were 544 fresh successful cached assessments,
98 confirmed label effects, and zero trash effects. Pending work retained retry
state for the host's four-call concurrency limit. The backlog was not claimed
complete. The original failed no-action job remains in history.

The original approved-sender settings, activation/backlog cutoffs, prior state,
credentials and Gateway service definition were preserved. Private evidence
remains on Bill; no mail bodies, subjects, message IDs, or credentials are
included in this report. The watcher was later paused for the explicitly requested
v0.3.3 no-effects classification preview.

### Host-specific findings

- OpenClaw 2026.9.9's Decisions provider host has a hard-coded
  `MAX_CONCURRENT = 4`. Its `overloaded` result occurs before Jev is called;
  it is not evidence of Jev capacity exhaustion. The plugin remains configured
  at the requested 50. Unfinished action and label work retries rather than being
  dropped. A separate host-level configuration change was approved and remains pending.
- Starting the background service within an installer RPC retained the install
  client's authority in OpenClaw's async context. When that connection closed,
  the agent-wait observation was cancelled and the following poll returned
  `Gateway caller authority is no longer active`. Re-enabling the watcher through
  the config-file watcher avoids the short-lived installer request context;
  the Gateway process and service definition do not need replacement.
- The first combined queue wake covered 52 messages. It was due immediately
  because previously tracked ignored mail retained its older discovery time.
  The terminal agent receipt confirmed it could not read the now-inactive job
  and took no email actions. After a consistent database backup, those exact
  52 messages were requeued together without removing the failed-run history,
  changing daily queue timing, clearing decisions, or replaying a send.
- Live Gmail reads verified at least one actual applied message for each of
  the five configured labels. There were no archive or trash effects.
