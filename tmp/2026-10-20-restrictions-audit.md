# Fresh restrictions audit — 2026-10-20

The baseline findings below are preserved as audit history. All six numbered code
findings are now fixed locally; see **Six-finding implementation and validation**
at the end. No release or Bill deployment has been performed for these changes.

## Scope and method

Read-only audit against baseline commit `f7dc72e4d5d2fc4870757097e588195417b2bb92` (v0.3.6). Line references below refer to that baseline; the parent task is concurrently changing reply behavior.

I read all seven production source files end-to-end (2,097 lines), the manifest, package/inspector configuration, README, release scripts/workflows, relevant workflow tests, and GitHub issue #1. I traced all eleven registered tools, the Gateway RPC and CLI, status command, service lifecycle, discovery, inference, labeling, dispatch, completion, sending, recovery and historical scans. A rejection/limit keyword inventory was a cross-check after the control-flow read, not the audit method.

The original issue explicitly required preserving sender authentication, sender restrictions, activation cutoffs, recipient checks and uncertain/duplicate-send safeguards. Later user requests supersede its former review/quarantine, budgeting, owner-envelope, label-naming and throughput restrictions. This report distinguishes those categories rather than calling every `throw` excessive.

No production/test files, Bill configuration, mailbox content, releases or commits were changed by this audit. No live mailbox request was made. No tests were run during this audit because the parent task was changing the shared tests; the findings below are source-traced, not claims of fresh runtime reproduction. The applicable OpenClaw plugin skills guided entrypoint/manifest tracing; test-audit guided evaluation of existing regression coverage.

## Highest-value remaining findings

### 1. P1 — A wait deadline revokes a still-running agent's ability to finish

**Classification:** self-imposed lifecycle restriction, not a provider requirement.

**Evidence:** `src/workflow.ts:483-491` waits at most `agentWaitTimeoutSeconds` (default 660), returning `timeout` without cancelling or confirming termination of the host run. `runAgent` turns that into an error at lines 499-501. Responder finalization changes the job to `needs_review` at lines 443-447; triage finalization changes it to `failed` at lines 552-557. `activeJob` at lines 475-478 then rejects every later reply/complete/defer/skip from the still-running, otherwise correct session.

**Affected flow:** OpenClaw queues the run for more than eleven minutes, or the agent legitimately does long work. The plugin declares the job failed while the host continues. The agent later calls the correct tool and is told its job is inactive. Increasing the setting postpones this failure; it does not correct it.

**Minimal fix:** distinguish an observation timeout from a terminal host outcome. Preserve the running job and `run_id` and continue observing it rather than revoking authority or redispatching. Only terminal host failure or explicit reconciliation should close it. The 10-second observation slice and 250-ms pending backoff are polling mechanics, not the defect.

### 2. P2 — Historical cleanup stops all routine discovery and new wake dispatch

**Classification:** self-imposed global serialization broader than the actual correctness need.

**Evidence:** `src/workflow.ts:610-669` holds `scanning = true` through all historical discovery, Jev assessments and Gmail writes. `poll()` returns immediately while scanning at line 183, and `processNext()` does the same at line 379. Scan entry also rejects while a routine poll is in progress (line 598).

**Affected flow:** a large date-range scan or slow historical request can run for hours. New urgent messages are not even discovered during that interval, and already-queued agent jobs cannot start. The CLI's response timeout does not stop the scan or release this lock.

**Minimal fix:** scope coordination to actual conflicting discovery/mutation phases or the same message, rather than keeping a mailbox-wide stop flag for the complete scan. Preserve “collect IDs before mutating the search result set”; do not simply delete the lock without replacing that ordering guarantee. Existing active agent runs are not paused by the lock, so it is already not a comprehensive no-race guarantee.

### 3. P2 — One failing label blocks all healthy labels for that conversation

**Classification:** self-imposed all-or-nothing coupling between otherwise independent categories.

**Evidence:** `src/triage.ts:154-163` collects every matching label and awaits `Promise.all(names.map(name => mail.labelId(name)))` before applying any. A single Gmail label lookup/create error, or the mailbox-state-label rejection at `src/mail.ts:461-462`, aborts this whole group. `processLabels` then retries the whole conversation at `src/workflow.ts:303-308`.

**Affected flow:** policy has valid `Receipts` and one invalid label name. Jev says both apply. The valid receipt label never gets applied until someone repairs/removes the unrelated invalid definition.

**Minimal fix:** apply successfully resolved categories independently and retain an actionable error for failed categories. Reuse the cached assessment; do not require another Jev call just because Gmail rejected one name. This does **not** require allowing `TRASH` through the categorization path: changing mailbox state is a different action from categorization. Action inference/waking is already independent of labels and must stay that way.

### 4. P2 — All agent executions are hard-serialized, independently of configurable inference concurrency

**Classification:** self-imposed execution-capacity policy; documented but not configurable.

**Evidence:** one `working` Boolean at `src/workflow.ts:93`, the gate at line 379, one selected job at lines 385-387, and `await dispatchWake`/`await runAgent` before releasing the worker (lines 387 and 439). `settings.concurrency` affects conversation assessment/refresh and historical scans, not agent execution.

**Affected flow:** a long or host-queued email job blocks a later urgent conversation from starting even though the later job has its own session and the host has capacity. A batched triage cycle also waits behind the previous cycle's run.

**Minimal recommendation:** make the distinction explicit and decide whether multiple independent cycle/thread runs are wanted. If yes, a separate agent-run concurrency setting can bound independent jobs, preserving serialization within the same responder thread. Do **not** split one triage cycle into many wakes: the user explicitly requested one wake per cycle. This is a design choice to confirm, not grounds for silently launching 50 agent runs.

### 5. P3 — MIME nesting deeper than 30 rejects an entire conversation indefinitely

**Classification:** arbitrary parser implementation cap, not a demonstrated Gmail/Jev contract.

**Evidence:** `src/mail.ts:402-420` recursively validates every part and throws once depth exceeds 30. `poll` retries the same unchanged failure forever (`src/workflow.ts:239-243`). The cap is neither configurable nor limited to the malformed part.

**Affected flow:** deeply nested forwards/attached-message MIME can make otherwise useful text in the same thread permanently unavailable to triage and replying.

**Minimal fix:** use iterative MIME traversal (including downstream body/attachment/evidence walkers) if removing the cap. Merely deleting the guard while preserving recursive walkers changes the failure from a clear error to a stack overflow. A depth override is smaller but keeps an arbitrary cap as the design; the existing subprocess output-byte setting already provides a configurable size bound.

### 6. P2 — Recovery can only mark unfinished work done, never deliberately resume it

**Classification:** deduplication is necessary; the completion-only recovery interface is self-imposed.

**Evidence:** `resolve()` at `src/workflow.ts:718-727` accepts `needs_review`, `failed` or `interrupted` jobs and unconditionally marks the job/messages complete. Startup converts all `running` jobs into unresolved states (`149-151`). In responder mode, any older `needs_review` job also diverts all later queued messages in that thread to review (`391-393`).

**Affected flow:** a run is known to have failed before doing any work, but the only public recovery action claims the email is done. Alternatively, an uncertain old execution blocks new, independent requests in its thread indefinitely. Policy edits do not reactivate these failed jobs, by design.

**Minimal recommendation:** retain send receipts and never automatically replay unknown external effects. Add an explicit recovery disposition for work reconciled as not performed, or support resuming observation of a known live `run_id`. Do not equate “no send receipt” with “no external side effects”: agents retain normal tools. This is operational recovery, not justification to restore the removed Jev `review` category.

### 7. Documentation regression — README still teaches the old urgent-only default

**Classification:** accidental user-facing restriction.

**Evidence:** `README.md:216` quotes “Wake only for owned work that cannot wait until the next queue”. The actual default at `src/policy.ts:68` also wakes unresolved approved-human reply/acknowledgement requests without urgency.

**Affected flow:** an agent copying the documented default into a custom policy restores the very wake-miss behavior v0.3.6 fixed.

**Minimal fix:** correct that quoted default, or avoid maintaining a second verbatim default in prose.

## Reply restrictions covered by the parent's current implementation

These are included to prevent the audit from overlooking the initial bug again:

1. `replyAllowed()` hardcodes triage/digest false (`workflow.ts:340-342`), the triage dispatch omits the reply tool (`546-550`), context repeats that global false (`561-569`), and `reply()` rejects triage outright (`737`). A configurable Boolean alone cannot fix all four layers.
2. Triage owns multiple real Gmail threads, but the stored job's `thread_id` is the synthetic string `triage` and its target is blank (`333-334`). Reply must select a real conversation/target already owned by the batch, not call Gmail using those synthetic fields.
3. `hasReplyForJob` and job-global `status='replied'` (`742`, `758`, `770`) allow only one send for the whole job. With batched triage this would make one reply disable all remaining conversations. Preserve deduplication per actual conversation/target, not per entire multi-conversation wake.
4. `complete`, `skip` and `defer` operate on the entire batch (`572-581`, `779-785`); all-message finalization is at `556-557`. Partial progress must not make a defer replay already-replied threads or mark unhandled work complete.
5. `reply()` reuses responder `eligibility(..., cutoffs())` at `747`. That contains `before-activation` rejection (`mail.ts:211-217`) even though triage intentionally includes recent pre-install backlog (`workflow.ts:193-199`). Once the blanket ban is removed, this otherwise remains a hidden denial for valid approved-sender backlog replies. Discovery cutoff and current send authorization are different checks.
6. A global `sending` Boolean (`workflow.ts:733`) rejects simultaneous sends even to independent conversations. In today's one-job/one-reply architecture this is mostly redundant. For batched replies, serialize transparently or use the durable target reservation rather than presenting an arbitrary mailbox-wide refusal.
7. Alternate reply targets are currently allowed only with `externalScheduling` (`738`), even for non-scheduling replies wholly within an authorized conversation. Separate “which owned message am I replying to?” from “who may receive this message?” instead of coupling target selection to a scheduling label.

## Other inherited or self-imposed behavioral choices

These are visible limitations, but are not all bugs or recommendations to remove safeguards.

| Behavior | Enforcing source | Classification and recommendation |
| --- | --- | --- |
| Only approved senders/domains authorize ordinary replies; external triage can wake without reply authority | `mail.ts:201-220`; `workflow.ts:747-754` | Original issue explicitly preserves sender authority. Do not silently interpret `replyAllowed=true` as all-sender authorization. Document the distinction. |
| Exact domains only, no wildcard/subdomain inheritance | `mail.ts:110-114,204,239` | Explicit approval semantics, not a throughput restriction. Listing more domains/senders already works. |
| Only Gmail-reported first `Authentication-Results` with matching DMARC pass qualifies | `mail.ts:156-167` | Original authentication safeguard. Not a Gmail protocol requirement for *reading* mail; triage still reads other mail. A configurable send-auth policy would be a separate authority decision, not part of removing triage's blanket ban. |
| Auto-Submitted, list/bulk precedence, List-ID and six no-reply local parts are never responder/reply eligible | `mail.ts:11,164-166,218` | Inherited loop prevention, partly heuristic rather than technical fact. A legitimate approved sender using list transport can be excluded. If needed, configure an explicit automated/list override rather than treating every notification as an instruction. |
| Reply-To and Bcc never affect delivery | `mail.ts:230-247`; prompt `workflow.ts:373` | Inherited recipient policy, not Gmail necessity. Legitimate ticket routing via Reply-To is unsupported unless agent explicitly uses `externalTo`. Bcc reply-all has privacy implications; do not combine the two into one permissive switch. |
| External visible recipients automatically included only for “scheduling”; other external recipients require explicit `externalTo` | `workflow.ts:369-371,738,753-754`; `index.ts:69-75` | Business-specific convenience branch. Gmail has no scheduling-only recipient rule. Existing `externalTo` already offers explicit scoped addressing; consider a simple recipient contract instead of more task-type branches. |
| Prompt forbids direct gog/Slack/other delivery for the email response | `workflow.ts:353,373` | Prompt-only boundary, not host tool isolation. Receipt-managed mail prevents duplicate sends; a blanket Slack-response prohibition is a workflow choice, not technical necessity. Normal non-mail work is not globally tool-blocked. |
| Body is plain-text input rendered as HTML; forced gog signature; no attachment/subject customization | `index.ts:72`; `mail.ts:325-345,473-484` | Narrow helper feature surface, not security necessity. Configure only if there is a real need; do not build a second general email client. |
| All active-job mutations require exact dispatched session | `workflow.ts:475-478` | Correctness/workflow ownership from original issue. A helper subagent cannot mutate the parent's job directly. Delegated analysis can return to the owner; delegated mutations would require an explicit ownership-transfer contract. |
| Policy/inspect tools require a session and running service | `index.ts:27-28,58-64`; `workflow.ts:682-719` | Current service architecture, not an owner allowlist. Bootstrap edits remain possible in the file. No dedicated offline policy editor or terminal policy RPC. |
| Only one mailbox and one configured agent per plugin instance | `mail.ts:14-24`; `index.ts:35-45` | Architectural scope. Not evidence of a defect for the requested per-node mailbox workflow. |
| No first-class dry-run/preview tool | `index.ts:135-151,174-192`; `workflow.ts:590-674` | Usability gap versus the original issue and repeated operational dry runs. Public scan applies deletions. Previous bespoke evaluation scripts are not a supported preview API. Do not call scan a dry run. |
| No API to reclassify one completed/skipped item, aside from policy-driven replanning of eligible statuses | `policy.ts:110-123`; `workflow.ts:695-727` | Avoids replay but limits targeted diagnostics/correction. A read-only preview is preferable to mutating policy just to inspect one item. |
| Changing file settings resets the full settings block; live updates patch | `policy.ts:129-150,159-169` | Documented precedence, not permission enforcement. Agents must preserve file settings intentionally. |
| Policy updates require the full four-field document, but settings updates are patches | `policy.ts:51-56,159-169` | Deliberately narrow API plus optimistic version guard. Removing the version check would reintroduce lost updates; a policy patch is convenience, not necessary for this fix. |
| `queueMinutes` must be positive; no “never wake queues” null mode | `policy.ts:54`; `workflow.ts:316-319` | Matches user's explicit choice to keep configurable queue wake interval. Not currently a missing requirement. |
| Classification considers threads; oldest context removed first when oversized | `evidence.ts:42-75`; `triage.ts:63-94` | Explicit user request. Truncation uses estimated token settings and does not force review. |
| Labels only add; editing/removing definitions does not remove prior labels | `triage.ts:154-164`; `policy.ts:122-123` | Preservation of existing labels, not arbitrary blocking. An authoritative reclassification/unlabel mode would be new behavior. |
| Read/star/label changes alone do not reclassify or re-wake | `evidence.ts:20-22`; `workflow.ts:208-213,515-522` | Explicit anti-repeat behavior. These properties are inference context when inference otherwise occurs, not independent triggers. |
| Existing successful skipped/queued results are not polled through Jev repeatedly; day change alone does not reassess | `workflow.ts:213,515-522`; `triage.ts:40-60` | Explicit user preference to avoid recurring re-review. The current date participates in request/cache identity when an actual reassessment is requested. |
| One successful classification per source/question/date/model; provider fallback forbidden | `triage.ts:40-60,80-81,152-153` | Correctness/data-routing contract. No arbitrary second provider request or confidence threshold. |
| Failed historical items require a deliberate rerun; only latest scan report retained | `workflow.ts:598-607,643-673` | Scope-preserving execution/reporting choice. No automatic scan replay after restart. Report errors honestly; do not invent a new scan-history framework without need. |

## Numerical caps, exclusions and permission checks inventory

### Configurable in this plugin already

- Action concurrency: default **50**, `settings.concurrency`; independent label concurrency inherits it. No plugin upper bound (`policy.ts:11-24,32-48`, `concurrently:176-183`). Every item is visited; this is simultaneous capacity, not a per-cycle quota.
- Polling default **120 sec**, configurable down to 1 second.
- Retry eligibility delay inherits poll interval; zero allowed; **no attempt ceiling, exponential backoff ceiling, daily request allowance or dollar budget** (`workflow.ts:239-243,303-308`).
- Decision request timeout **30 sec**, gog subprocess timeout **90 sec**, agent observation deadline **660 sec**, gog stdout maxBuffer **10 MiB**.
- Discovery overlap **600 sec**, reconciliation interval **3600 sec**, reconciliation lookback **7 days**; all adjustable.
- Rolling age **30 days**, `null` disables; explicit historical scans exempt. Age uses Gmail internal timestamp, not sender Date. This was explicitly requested.
- Estimated Jev state+largest-question budget **32,000 tokens**, state+all-questions budget **64,000 tokens**; both configurable and now user-requested trimming, not the removed 16k-byte cap. Policy text is never silently trimmed.
- CLI scan-response wait **1800 sec**, configurable `--timeout`; it does not cancel the scan.
- Prompt snippets, classification/deletion prompts, labels and their descriptions have no plugin length/count caps.

### Hardcoded but mainly implementation/correctness constants

- Gmail search page size **100**, then all pages followed (`mail.ts:377`; `workflow.ts:156-166`). Not a total-result limit. Repeated page token stops an otherwise infinite loop.
- MIME depth **30**: finding #5.
- Gmail IDs must be hexadecimal, length **1–64** (`mail.ts:12,76-78`). Current Gmail IDs fit, but the length is an undocumented local assumption rather than a public opaque-ID contract. Low-priority cleanup; no demonstrated current mail loss from this limit.
- Agent wait observation slices **10 sec**, immediate-pending sleep **250 ms** (`workflow.ts:486-489`). Not work limits.
- SHA-256 identity slices **16 hex** for mailbox directory and **24 hex** for jobs (`index.ts:36`; `workflow.ts:331,415`). Identity representation, not quotas.
- One active agent job, one sending call, one historical scan, one poll and one label-worker pass per workflow. Only the first two are silent capacity restrictions; same-phase guards prevent duplicate scheduling. Scan guard scope is finding #2.
- Received mail excludes Spam/Trash/Sent/Draft; triage also requires Inbox, historical cleanup includes archived received mail (`mail.ts:376`; `workflow.ts:266-271,626-627`). These are declared scope choices, not unknown safety budgets.
- Categories cannot apply INBOX/SPAM/TRASH/SENT/DRAFT (`mail.ts:461-462`), but may apply other system flags. This maintains the requested separation of categorization and action. Finding #3 is the unnecessary coupling of a failing category to valid ones.
- No automatic permanent-delete or purge path. `delete` moves eligible message IDs to Trash (`triage.ts:127-129`). Gmail's retention is upstream behavior.
- Nonempty deletion instructions are required; failure is never mapped to deletion (`triage.ts:54,66,75`; `workflow.ts:592`). This is explicit delete intent, not forced review.
- Stale mail/policy effects are retried rather than applied using obsolete assumptions (`triage.ts:32-35,97-124`). Each mutation is limited to intended IDs and fresh scope; these are correctness safeguards.
- Only future integer-second deferrals, valid date ranges, well-formed addresses/receipts and schema-recognized fields are accepted. These reject nonsensical/ambiguous input, not useful volume.
- No forced file modes or file-owner allowlist exists. Normal process umask is used (`state.ts:42`; `workflow.ts:278,433`; `mail.ts:477-480`).
- Policy tools do not require `senderIsOwner`; ordinary and delegated sessions can edit (`index.ts:58-64,118-132`; workflow test at `test/workflow.test.ts:184`).
- Gateway historical scan uses host `operator.admin` scope (`index.ts:174-178`). The agent tool is separately registered with no owner gate. Host authentication is not a plugin file-permissions restriction.

## Host/provider constraints are separate

This audit did **not** inspect or change Bill's current running host. The installed local OpenClaw documentation is source evidence for its documented contract, not proof of Bill's current deployment:

- `node_modules/openclaw/docs/concepts/decision-models.md:300-305` documents native host admission limits: **4 concurrent requests per provider, 30-second deadline, 1 MiB request, 20,000 JSON nodes, nesting depth 32 and 256 questions**. These limits are outside this plugin; changing plugin concurrency/timeout settings alone cannot raise them.
- `node_modules/openclaw/docs/plugins/typesafe.md:228-233,253-264` confirms deadline/cancellation ownership, no automatic provider retry, and 413/422 handling as unsupported input.
- The repository README separately states TypeSafe's provider JSON transport cap as 4 MiB (`README.md:562-570` region). Host admission can be tighter than provider transport. Do not present the larger provider limit as the effective end-to-end bound without runtime verification.
- Jev's token ceilings are upstream; this plugin's `cl100k_base` estimate is not Jev's tokenizer. A request can still fail upstream after local fitting. Unsupported requests remain retryable here; no adaptive token-backoff is currently implemented.
- There is no plugin batch-limit adapter for **more than 256 configured label questions**. All labels share one request (`triage.ts:146-153`), so the host's question cap can make a large label configuration fail forever despite the plugin accepting it. This is host-imposed capacity exposed as a plugin usability limit. If such label counts are needed, split label requests by the actual host contract rather than inventing a new arbitrary count.
- OpenClaw tool deny policies and native runtime capabilities may still restrict `toolsAlsoAllow`. The plugin uses additive tool exposure, not a guarantee that host-denied tools become allowed (`workflow.ts:494-501`).

## Full-path coverage map

| Public/background entry | Traced implementation | Principal restrictions verified |
| --- | --- | --- |
| Service start/stop | `index.ts:32-56` → `workflow.ts:84-153,789-815` → SQLite | Nonblocking startup; activation, startup interruption policy, saved state, cancellation, idle-close semantics |
| Scheduled/manual poll | `workflow.ts:182-257` → `discover/searchPages` → `mail.searchPage/getThread` → `assessInbox` | Scan/poll guard; all-page discovery; rolling age; sender mode; grouped inference; retries; no throughput budget |
| Action inference | `triage.ts:40-94` → `evidence.ts:11-75` → host Decisions | Exact provider routing; cached successful outcomes; configurable token fit; one choice per chain; no confidence veto |
| Independent labels | `workflow.ts:295-311` → `triage.ts:131-166` → `mail.ts:433-470` | Independent worker capacity; current policy/evidence; scope; all-or-nothing label-resolution defect; no name prefix/count cap |
| Wake/queue dispatch | `workflow.ts:314-338,378-472,504-559` → `runAgent/waitForAgent` | One cycle wake; persisted cadence; recheck before wake; serialized execution; timeout closure |
| `gog_email_context` | `index.ts:101-107` → `workflow.ts:561-570` | Session ownership; grouped context; replyAllowed blanket ban |
| `gog_email_reply` | `index.ts:66-86` → `workflow.ts:731-777` → `mail.ts:201-260,473-487` | Active job; triage ban; approved sender/auth/cutoff; target/recipient restrictions; serialized send; intent-before-send; receipt dedup |
| `gog_email_complete` / `gog_email_defer` | `index.ts:109-117` → `workflow.ts:572-583` | Active session; whole-job outcome; reply-attempt guard; future defer |
| `gog_email_skip` | `index.ts:88-99` → `workflow.ts:779-787` | Active session; whole-job outcome; no skip after uncertain send |
| `gog_email_policy_get/update` | `index.ts:118-132` → `workflow.ts:682-694` → `policy.ts:90-172` | No owner gate; optimistic version; patch settings/full policy; file precedence; selective replan |
| `gog_email_scan` / RPC / CLI | `index.ts:134-142,174-193` → `workflow.ts:585-680` → historical assessment/effects | Explicit range/delete intent; no wake/queue/labels; global lock; all pages; latest-only report; no implicit resume |
| `gog_email_resolve` | `index.ts:144-151` → `workflow.ts:718-729` | Reconciliation note, unresolved statuses only, completion-only recovery, receipts preserved |
| `gog_email_inspect` | `index.ts:159-169` → `workflow.ts:676-680,695-717` | Read-only; one selector; no sample cap; no activation or authority mutation |
| `gog_email_status` / chat status command | `index.ts:153-157,195-199` → `workflow.ts:817-843` | Pure local status; does not query Gmail/Jev; activeJob is plugin observation, not proof host run ended |
| Build/package/release | `package.json`, manifest sync, `.github/workflows`, publish script | Manifest parity; version/integrity/provenance checks; release tag on main. No runtime policy caps introduced here |

## Recommended order

1. Finish the requested reply-enabled batched workflow across all seven reply-path points above.
2. Correct the observer-timeout/active-job lifecycle mismatch and the historical scan's mailbox-wide pause.
3. Isolate label failures; remove the parser's arbitrary depth dependency with a safe traversal strategy.
4. Decide explicitly on independent agent-run concurrency and a narrow recovery/preview capability. These are useful customization decisions, not reasons to expand this change into another framework.

No recommendation here requires removing authentication, trusting email as instructions, permitting arbitrary recipients, dropping send receipts, automatically retrying unknown external effects, or restoring the removed review/quarantine/budget abstractions.

## Post-fix review — current uncommitted reply implementation

This follow-up reviews the parent's working diff, not the baseline above. Source and tests were read again; I did not execute tests or modify implementation/test files. The parent owns runtime validation.

### Verified in the working diff

- `settings.replyAllowed` is a Boolean with default `true`, declared in source and generated manifest and explained in README. Both ordinary and delegated agent policy updates can change it; no owner-only gate was introduced.
- The reply setting is checked at tool entry and again inside the durable-send transaction after the awaited Gmail read. A live disable while that read is in flight prevents the send. A send already started cannot be recalled.
- Changing the setting does not enter classification replanning. Existing policy/version semantics remain in place.
- The v0.3.6 and earlier recognized settings fingerprints preserve saved live overrides. Old saved settings inherit the new default through the existing merge. The new fingerprint represents explicit file settings rather than effective built-in defaults, preventing future default additions from looking like file edits.
- A review-discovered JSON-key-order problem was corrected: explicit settings are sorted before hashing, and ignored legacy `evidence` settings are excluded. Merely reordering file settings no longer resets saved live overrides.
- Triage dispatch exposes `gog_email_reply`. Shared reply instructions replace the contradictory no-reply branch. The new `jobConversations` helper is used by both context and reply selection, so these paths agree on the covered thread and target without a second state model.
- A `threadId` from job context selects a real covered Gmail conversation. It is required only when more than one conversation is covered. Unrelated thread IDs cannot select new work.
- Recent pre-activation triage work bypasses only the responder discovery cutoff; current sender allowlists, authentication, automated/self exclusions and recipient checks remain.
- Dedupe is scoped to the covered anchor message, including legacy alternate-target receipt keys. Different conversations can each reply; a normal retry cannot bypass an earlier alternate-target attempt. New messages in a later job may still receive a new reply.
- Confirmed triage sends mark only that conversation's processing messages done. The batch remains active for other conversations. Defer/finalization touches processing messages only, so replied conversations do not reappear when the deferred remainder resumes.
- An uncertain send blocks completion/defer but does not prevent another conversation being answered. Existing inspect/resolve paths remain available; unknown delivery is not automatically replayed.
- The global send rejection was removed. A simple in-flight counter retains shutdown bookkeeping, while the existing synchronous transaction's fresh anchor-receipt check and intent insert prevent same-target races before the external await. Independent conversations do not need a new queue or mutex.
- Responder-only reply behavior remains terminal for its one conversation; the live toggle also applies there.
- README now describes the current approved-request wake default, rather than reproducing the obsolete urgent-only prompt.

### Test design inspected

The changed tests exercise the workflow boundary with fake gog subprocesses and real SQLite rather than testing private helpers. They cover:

1. A multi-thread triage wake with pre-activation mail, disabled/enabled replies, an in-flight disable, invalid/missing conversation selection, concurrent same-target/different-target replies, alternate-target deduplication, partial deferral and restart.
2. An uncertain triage send, rejection of its replay, preserved completion guard, a separate successful conversation and refusal of an unapproved sender.
3. Existing responder delivery with live disabling/enabling, policy-tool edits from ordinary/delegated sessions, and saved-settings migration/restart preservation.

These are meaningful behavioral contracts. No new production-only-for-tests export or arbitrary workflow framework was added. Actual test pass/fail evidence must come from the parent's validation, not this source review.

### Explicit limitations retained, not concealed by `replyAllowed`

- The latest **covered** message remains the authorization anchor for each conversation. If an approved request is followed by a newer covered message from an unapproved participant, that conversation's helper reply is denied even if an earlier approved message is selected. This is a target-selection limitation separate from whether replies to the unapproved sender should be authorized. It was reported to the parent; no broader recipient authority was requested in this fix.
- Selecting a genuinely different earlier target is still restricted to scheduling. Passing the context's exact default target does not trigger that restriction.
- Confirmed replies have per-conversation progress; non-reply work still uses whole-job completion/defer. The change does not add a general per-conversation task state machine.
- `gog_email_skip` still rejects a job that has sent a reply; after mixed reply/no-action work the agent should use `gog_email_complete`. That does not block finishing the batch.
- The wait-deadline, historical-scan pause, label-failure coupling, MIME-depth, completion-only recovery and serial agent-run findings above remain report-only and are not claimed fixed by this reply change.

**Post-fix source verdict:** no additional correctness blocker found in the requested reply/config/migration/concurrency changes after the fingerprint and send-counter revisions. Retained authority/target-selection limits are explicit above. Fresh full workflow validation is still required from the parent task.

## Parent validation — completed

- Reproduced the missing reply setting and blocked triage reply path before repair.
- Reproduced the global send-lock failure with concurrent conversation replies:
  `another reply is being sent; retry after it finishes`.
- The first full run caught a context compatibility regression: a conversation's
  representative `id` had changed to the newest message. Restored the existing
  representative ID and exposed the reply destination separately as
  `replyTargetMessageId`.
- Final `npm run preflight` under Node 24.21.0/npm 11.13.0: **53 tests passed,
  zero failures**, plus typecheck, build/manifest parity, static inspection,
  real-SDK registration capture and package dry-run.
- Static inspection: PASS, zero live issues. The two existing generic proof gaps
  remain (isolated dependency installation and static registration-capture evidence);
  the separate real-SDK capture command passed.
- `git diff --check` passed. Production TypeScript delta: **+33 net lines**;
  tests/test support: **+133 net lines**. No new state tables, provider transport,
  queue framework or test-only production seams.
- README and manifest document the default-on, live-editable reply toggle.
- No commit, release, Bill deployment or live email was performed. Findings outside
  the reply/configuration change remain follow-up work, as listed above.

## Six-finding implementation and validation — 2026-10-20

User authorization: fix all six findings. The preceding reply-toggle changes were
preserved. This follow-up changes local source, workflow tests, manifest and docs
only; it does not commit, publish, deploy, restart Bill or send live mail.

### Disposition

1. **Observation timeout — fixed.** Agent observation renews on pending results,
   observation timeouts and host-marked retryable transport failures. It does not
   revoke the active job or redispatch it because time elapsed. Actual terminal
   host outcomes end observation. Terminal timeout metadata follows the installed
   OpenClaw contract, including `endedAt`, stop/liveness metadata, provider-started
   timeouts and terminal preflight/provider/post-turn phases.
   `agentWaitTimeoutSeconds` is now an observation-call maximum, sliced to at most
   ten seconds for stop responsiveness, not a total job runtime deadline.
2. **Historical global pause — fixed.** Routine polling and agent dispatch continue
   during historical scans. A small shared coordinator excludes Gmail
   label/delete writes only while message IDs are being paginated (and vice versa).
   Discoveries can overlap, as can writes; queued discovery gets priority over new
   writes. Stale polling results cannot overwrite historical deletion completion.
   The existing single-historical-scan rule remains because only one latest scan
   report is stored.
3. **All-or-nothing labels — fixed.** Each matching label resolves/applies
   independently; failures retain named errors without blocking other labels.
   Partial success does not force another Jev request: compatible classification
   is cached by content, questions, model and token settings, rather than our own
   mutable Gmail label metadata. Repeated effects reconcile current Gmail labels.
4. **Hard-serialized agent runs — fixed.** Live-editable
   `settings.agentConcurrency` controls independent jobs, default `1`, with no
   plugin upper cap. Increasing it starts waiting independent work immediately;
   lowering it lets active work finish. Whole triage cycles remain single wakes,
   and jobs sharing Gmail threads cannot overlap. `activeJobs` exposes all workers;
   `activeJob` remains the first entry for compatibility.
5. **MIME depth cap — fixed.** Validation, body/filename extraction and evidence
   traversal are iterative, without a nesting cutoff. Fingerprints flatten MIME
   structure as well, avoiding a hidden recursive `JSON.stringify` failure.
   Plaintext alternatives and attachment-content exclusion are preserved.
   The fingerprint format change can refresh unfinished work when next checked;
   it does not replay completed agent jobs.
6. **Completion-only recovery — fixed.** `gog_email_resolve` accepts
   `disposition: "complete" | "retry"` (default `complete`). Explicit retry cancels
   the old unresolved job and requeues unfinished messages for the next poll,
   retaining the predecessor ID so the next dispatch has a new idempotency key.
   Completed conversations and all send receipts survive. Sending/uncertain
   receipts still block retry: callers must reconcile external effects, not infer
   that missing acknowledgment means nothing happened.

README now explains each behavior, configuration default, recovery example and
remaining distinction between inference capacity, agent capacity and host limits.
The manifest was regenerated from the runtime schema.

### Behavioral proof

- Each original finding was reproduced before its repair: observation expiry
  lost completion; a historical scan suppressed discovery; rejected TRASH
  categorization blocked valid STARRED; agent concurrency was not configurable;
  depth-128 MIME was rejected; recovery closed rather than retried unfinished work.
- Workflow tests use real SQLite and the fake gog subprocess boundary, not new
  private-helper unit tests or production-only-for-tests exports.
- Coverage exercises long-lived responder/triage jobs, transient observations,
  terminal timeouts, live capacity changes, same-thread ordering, whole-cycle
  wakes, scan/poll overlap, delayed-page deletion ordering, independent label
  effects and cached retries, deep MIME, and explicit recovery after a partial
  triage reply.
- Final review found that terminal timeouts can omit `endedAt`/`stopReason`.
  Both provider-started-only and provider-phase-only timeout scenarios reproduced
  an endless observation loop before the predicate was completed; both now pass.
- The pagination test holds inbox page two while a historical scan finishes
  inference. No mutation runs until that page is read; both candidates are
  discovered, only the intended one is deleted, and stale polling does not
  resurrect it.
- Full `npm run preflight` under Node 24.21.0/npm 11.13.0 passed:
  **64 tests, zero failures**, typecheck, build/manifest parity, static inspector,
  real-SDK registration capture, and package dry-run.
- Static inspector: PASS, zero live issues. Its two pre-existing proof gaps remain:
  isolated dependency installation and registration evidence not linked into the
  static report. The separate real-SDK capture passed; this is not a claim of
  isolated installation or Bill runtime verification.
- `git diff --check` passed. Combined uncommitted production TypeScript delta,
  including the preceding reply change: **+118 net lines**; tests/test support:
  **+356 net lines**. No dependencies, database tables, persistent scheduler or
  general recovery framework were added.

The OpenClaw plugin skills guided schema/runtime/preflight alignment; test-audit
kept coverage at the observable workflow boundary. All six fixes are implemented
and locally validated. Commit/release/deployment remains a separate step.
