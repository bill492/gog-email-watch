# Inbox triage: code review and implementation plan

Saved from the review of https://github.com/unblocklabs-ai/gog-email-watch/issues/1 on 2026-10-19.
Baseline: `aebf26aac2b278cc1f61207e9833cfc22cc5cc2e`, plugin 0.1.1.
This records the proposal, not a claim that the proposed features are implemented.

## Recommendation

Implement this as an extension of the existing engine—not a rewrite. The issue's
separation of facts → assessments → policy → permitted actions is the right architecture.

Three adjustments:

1. Fix polling isolation and recovery first. Broader inbox coverage amplifies existing weaknesses.
2. Reuse OpenClaw's decisions integration. The OpenAI adapter exists on upstream main; don't build another.
3. Make preview, explanation, and recovery first-class features. These improve agent experience more than extra classifiers.

The review covered every runtime module, tests, configuration, packaging, CI/release
scripts, issue #1, relevant gog source, and current OpenClaw integrations. TypeScript
checks and all 11 tests passed. The review made no repository or GitHub changes.

## 1. Codebase review

### What is already good

The existing roughly 960-line implementation has a sensible foundation:

- One Gateway service and private SQLite state.
- Activation cutoffs and persistent message deduplication.
- Stable thread sessions and chronological conversation context.
- Gmail calls outside SQLite write transactions.
- Reply attempts recorded before sending.
- Conservative handling of interrupted runs and uncertain sends.
- Useful workflow tests using a real subprocess and SQLite.

Keep these properties. There is no reason for a queue framework, another scheduler,
or a general-purpose rules platform.

### P1: One unreadable thread stalls unrelated incoming mail

`src/workflow.ts:130` fetches every candidate thread before committing discoveries.
One failure discards the entire poll's progress. Reproduced: one valid message and
one unreadable thread across two polls produced zero persisted messages and zero
dispatches.

Fix: persist discovered IDs first, then process threads independently. Record failed
reads with retry state and continue other threads. Advance the discovery watermark
only after returned IDs are durable. This is essential for full-inbox observation.

### P2: needs_review is a permanent hold without a resolution path

Workflow line 204 blocks a thread whenever an earlier job needs review. Later
messages also become held. `src/index.ts:83` exposes aggregate status, but not
inspection or resolution. Conservative, but operationally incomplete.

Add review controls distinguishing classification uncertainty, agent-run
uncertainty, and uncertain external actions. Reclassification may resolve the
first; it must not automatically resolve the other two or authorize another send.

### P2: Send responses are neither validated nor retained

Workflow line 327 discards `mail.send()`'s result and marks the reply sent. The
`replies.result` column remains empty. Reproduced with fake gog: `{}` was accepted
as `status: sent`.

Validate the supported gog acknowledgment and persist message/thread identifiers.
A missing or malformed acknowledgment after an attempt remains uncertain; do not retry.

### Existing assumptions to make explicit

- `mail.ts:142` combines sender authority, authentication, automation exclusions,
  and activation eligibility. This is appropriate for responding, not broader
  observation. Newsletters and automated invoices may deserve classification
  even when they must never trigger autonomous replies.
- External-recipient exceptions rely partly on agent judgment: `externalTo`
  validates addresses, not whether an approved sender requested them. Preserve
  intentional delegation without claiming mechanically proven authorization.

## 2. Dependency correction

Current upstream OpenClaw contains an OpenAI Decisions adapter, a V2 decisions
contract preserving per-question errors/abstention/usage, and compatibility with
TypeSafe for representable text/JSON questions.

- Adapter: https://github.com/openclaw/openclaw/blob/8b1ac41c3145ae2ab1018d6c2f4ec5c43b576fc5/extensions/openai/decision-provider.runtime.ts
- V2 contract: https://github.com/openclaw/openclaw/blob/8b1ac41c3145ae2ab1018d6c2f4ec5c43b576fc5/src/decisions/types-v2.ts

The pinned SDK is 2026.9.2. The published v2026.10.5 tag checked during review does
not contain the OpenAI adapter or V2 surface.

Recommended: develop against a pinned supporting revision; consume
`api.runtime.decisions.evaluateV2`; set the minimum host to the first verified
supporting release once available. Do not add direct provider HTTP calls or a
compatibility framework to this repository.

Official API documentation: https://developers.openai.com/api/docs/guides/decisions
OpenAI Decisions requires Platform API credentials; ChatGPT/Codex subscription
access is insufficient.

## 3. Implementation design

### A. Owner authority versus agent preferences

Use two documents with different ownership:

| Owner-controlled configuration | Agent-editable policy |
| --- | --- |
| Observation scope | Interests/topics |
| Approved sender/action authority | Category definitions |
| Permitted workflow destinations | Routing among permitted destinations |
| Permitted mailbox actions | Rules selecting those actions |
| Protected messages/categories | Interruption preferences |
| Security questions and minimum safeguards | Additional usefulness questions |
| Approved provider/data sharing | Quiet hours/digests |
| Policy-editor identities and budgets | Plugin-owned label preferences |

Effective permission is their intersection. Policy tools cannot edit the owner
envelope. Security questions are not editable preference questions. Check trusted
caller identity at every tool boundary; never accept agentId, owner approval, or
authorization claims from arguments. Email sessions cannot edit their own policy.
This is not containment against unrestricted shell access to the same credentials.

### B. Small typed policy format

A versioned declarative document contains stable question/rule IDs, ordered rules
with typed conditions, a complete first-match outcome, conservative default,
timezone, and notification preferences.

Conditions: exact facts, category equality, probability thresholds, rubric
comparisons, bounded all/any groups. No JavaScript/general expression evaluator.

Outcomes separate mailbox disposition (retain/archive/trash), attention
(none/digest/wake/review), approved destination, plugin-owned labels, and explanation.
Validate combinations: trash must not also dispatch a responder.

Evaluation order:

1. Deterministic exclusions and existing workflow ownership.
2. Determine assessments needed.
3. Security/completeness requirements.
4. Protected-message exceptions.
5. Ordered preference rules.
6. Intersect the plan with current owner authority.

Unknown is a real state. A missing/refused security answer is not false and cannot
fall through to a permissive rule.

### C. Independent discovery, classification, execution

Discover IDs → persist pending work → fetch evidence → assess if needed → evaluate
policy → persist plan → execute permitted effects.

- Keep the existing poll timer.
- Replace unbounded --all with bounded pages/persisted progress.
- Preserve overlap/reconciliation and activation cutoffs.
- Triage independently of agent execution.
- Start with one bounded triage worker and the existing single agent worker.
- Persist next_attempt_at/due_at for retries and digests; no second scheduler.
- Abort owned reads/classifications on stop and await settlement. Interrupted sends stay uncertain.
- Empty polls do zero classification calls and zero dispatches.
- Deterministically exclude externally owned workflows before inference.
- An exclusion is not an acknowledged handoff.

### D. Explicit evidence, not rendered Markdown

Add evidence.ts: IDs, chronology, identity/authentication facts, untrusted
subject/body, relevant history, inert link destinations, attachment metadata,
and explicit coverage (omission, unsupported formats, truncation, unscanned attachments).

bodyText is useful for transcripts but omits attachment contents and HTML link
destinations. It cannot prove whole-message screening. Screen what will actually
be exposed to the agent; re-fetch before dispatch and invalidate changed evidence.
Incomplete/oversized evidence goes to retain/review, never silent clean truncation.
Quarantine summaries must not leak suspicious bodies into ordinary digests/prompts.

### E. Assessment separate from policy

assessment.ts is a thin OpenClaw consumer, not a new provider abstraction. One
selected provider per evaluation; batch independent questions over shared evidence:
category, actionability, marketing, credential/payment fraud, instruction override/
exfiltration, urgency. Ask only what the policy and fixed safeguards need.

Persist estimates unchanged, including unavailable/error results, provider/model,
rubric, usage, provenance. Cache by evidence + relevant context + questions +
provider/model identity. Thresholds are not cache keys. Changing thresholds
recomputes plans without another model call. Provider changes need fresh
calibration. A floating alias is not a pinned checkpoint.

### F. Small executor and durable receipts

actions.ts owns mailbox effects. gog 0.37.0 supports message-scoped batch label
modification. Add approved plugin labels; archive by removing INBOX from explicit
message IDs; preserve unrelated labels and read/unread state; never mutate a thread
as a substitute.

For each effect: persist intent/idempotency → recheck authority/preconditions →
execute outside the transaction → validate/persist acknowledgment → reconcile
uncertainty before retry. Labels/archive can inspect Gmail state; sends are not
equivalently retryable. No arbitrary Gmail mutation tool. Trash is a later explicit
opt-in; no permanent deletion or Trash purge.

### G. Extend SQLite without replacing history

Add migrations and records for policy versions, triage items/retries/review/due
times, assessments/coverage/usage, action plans/receipts, and digest membership.
Extend jobs with admitted policy/evidence/destination and returned run/session IDs.
Keep existing messages/jobs/replies/cutoffs/holds. Dispatch identity must not depend
on policy version. Migration must not replay historical mail; broadened observation
and live activation have explicit boundaries.

### H. Useful tools

| Tool | Contract |
| --- | --- |
| gog_email_policy_get | Version, editable fields, effective permission limits |
| gog_email_policy_preview | Bounded sample, actions/reasons/differences/coverage |
| gog_email_policy_update | Validated replacement + expectedVersion + immutable history |
| gog_email_review | Typed list/inspect/re-evaluate/release/resolve operations |

Preview defaults to compatible cached assessments. New evaluations are bounded
and distinguishable. Show suppressed/new wake-ups and proposed mutations. Reject
stale versions and unauthorized fields. Rollback creates a new version, preserving
history. Release needs fresh assessment/authority and cannot clear uncertain sends.

## 4. Agent-experience enhancements

1. Concise briefing: why now, what changed, owned messages, completed work, allowed
   actions/recipients, uncertainty. Add gog_email_context(jobId) for an authorized
   snapshot while retaining full transcript access.
2. Honest completion: completed without reply, clarification needed, deferred,
   acknowledged handoff. Narrow complete/defer operations avoid false skip/review.
3. Explainable corrections: store corrections as evaluation evidence and preview
   narrow policy adjustments. Never silently retrain or broaden authority/security.
4. Useful recovery: oldest pending item, exact blocker, provider/evidence/run/send
   uncertainty distinctions, next safe action. No SQLite spelunking required.

## 5. Delivery sequence and proof

1. Reliability/recovery: per-thread isolation, send receipts, run identity, review.
2. Policy/shadow: envelope/schema/evidence/assessments/evaluator/cache/preview.
   Shadow may save local results, but cannot mutate Gmail, dispatch, or consume
   existing work as completed.
3. Labels/approved wake-ups: separately authorized canary through the real Gateway,
   decisions runtime, gog, and agent path.
4. Digests/quiet hours/archive: durable scheduling, timezone/DST, catch-up,
   acknowledgments, reconciliation.
5. Optional trash: explicit approved/evaluated rules and protected exceptions;
   should not delay earlier useful stages.

Workflow tests: bad alongside good mail; observation without reply authority;
mixed threads/message-scoped effects; refused security with valid category;
evidence changes; policy edits during execution; restarts around effects/receipts;
quarantine release with unresolved send; duplicate digest/dispatch prevention;
email-session policy escalation. One real-Gateway synthetic E2E, separately from
provider-quality evaluation of misses, false quarantine/trash, unnecessary wake-ups,
latency, and usage.

Preferred first milestone: reliable discovery, recoverable held work, versioned
policy, explainable shadow previews, shared decisions integration. Review validation
was synthetic only: no live mailbox/provider calls, sends, or fleet changes.

## Implementation decisions (2026-10-19)

The approved implementation extends the existing engine in place:

- Use the released OpenClaw 2026.9.9 V1 Decisions interface. V2/OpenAI support is
  not yet in the published host checked here; no upstream patch or private provider
  transport was added to this plugin. Jev is pinned to 1.13.0 for Bill's evaluation.
- Keep one poll timer and one agent worker. SQLite uses additive tables/columns;
  original sender cutoffs, jobs, held work and reply deduplication survive.
- Policies use ordered `all` conditions only. No arbitrary expressions, provider
  framework, generic executor, or second scheduler. The shared runtime owns provider
  cancellation/deadlines; a narrow effect journal owns message-scoped acknowledgments.
- Historical scans and archive/trash CLI commands are review-only. They save local
  evidence/estimates, never modify Gmail or enqueue jobs. Bill's live action envelope
  excludes archive/trash and keeps both in `reviewActions`.
- Policy changes require an approved editor plus trusted owner context. Incoming
  email and delegated subagent sessions cannot change policy or resolve holds.
- Completion/defer and metadata-only digests are implemented; automatic external
  digest delivery and acknowledged cross-workflow handoff are deliberately not claimed.
- Corrections are audit records, not silent retraining. Reevaluation preserves old
  assessments and requests fresh estimates; it never overrides fixed safeguards.
- Attachments and oversized/incomplete threads remain retained for review. There
  is no attachment scanner, remote link fetcher, permanent delete or Trash purge.

Validation includes reproducible failing regressions for poison-thread discovery
and malformed send receipts, real subprocess/SQLite workflow tests, TypeScript,
package inspection and an isolated real-Gateway/Jev synthetic canary on Bill.
Canary observations are integration evidence, not a calibrated accuracy benchmark.
Release/deployment evidence is recorded separately after those steps complete.
