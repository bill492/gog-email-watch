# gog-email-watch

Triage Gmail with explainable policies and wake an OpenClaw agent for approved
senders, using the node's existing `gog` CLI and credentials.

Ported from Alfie's `alfred-internal-mail`: qualifying email → full thread context →
agent run → in-thread reply or explicit skip. Not just a notification watcher.

## How it works

- One Gateway service polls gog. Exact sender domains or individual addresses qualify;
  the original authentication, self-mail and automated-message exclusions still apply.
- SQLite persists activation cutoffs, deduplication and queued work. Old mail does
  not trigger jobs when first enabled or when a new sender is added.
- New messages are grouped by thread. One agent job runs at a time while polling
  continues, with a stable session and a full chronological conversation file.
- The agent uses `gog_email_reply` or `gog_email_skip`. Replies retain the original
  recipient filtering, explicit external-recipient and scheduling exceptions, and
  gog signature. Final chat output is not itself sent as email.
- Discovery is paginated and persisted before thread reads. Failed threads retry
  with backoff independently, then enter review after three failures. Interrupted
  jobs and uncertain sends remain held, with supported review/reconciliation controls.
- Optional triage uses OpenClaw's shared Decisions runtime, versioned policies,
  immutable owner permissions, cached assessments and message-scoped receipts.

Seven source modules: registration, gog/mail rules, SQLite, workflow, evidence,
policy and triage. No daemon, OAuth manager, queue framework, provider transport,
or separate scheduler. See [scope.md](scope.md) in the source repository.

## Setup

Requires **OpenClaw 2026.9.9+** and **gog 0.37.0** command format.
Use a Node version supported by OpenClaw (see `engines` in `package.json`).
The account must already be authenticated in gog, and the Gateway must have access
to that same executable, credential store and environment.

Install the published package:

```sh
openclaw plugins install npm:@unblocklabs/gog-email-watch
```

Or build and link this repository for development:

```sh
npm ci
npm run build
openclaw plugins install --link .
```

Add `gog-email-watch` to your existing `plugins.allow` list and merge this entry
into your OpenClaw configuration:

```json
{
  "plugins": {
    "entries": {
      "gog-email-watch": {
        "enabled": true,
        "config": {
          "account": "agent@example.com",
          "domains": ["example.com"],
          "senders": ["bek@unblocklabs.ai"]
        }
      }
    }
  }
}
```

Either sender list may be omitted; at least one must be nonempty. Domains match
exactly, not their subdomains. Optional settings:

| Setting | Default |
| --- | --- |
| `agentId` | `main` |
| `pollIntervalSeconds` | `120` |
| `gogPath` | `gog` on PATH |
| `selfAddresses` | `[]` (the account itself is always excluded) |

Restart the Gateway after configuration changes. The mail jobs retain the agent's
normal tools, with the reply/skip tools explicitly allowed for dispatch. The agent
needs its usual file-reading access to read the conversation file.

Use `/email-watch-status` to see polling errors and queue/job counts. SQLite and
conversation files live under the Gateway state directory at
`gog-email-watch/<mailbox-hash>/`, outside the installed package. These files contain
mail content; preserve the database across upgrades to retain deduplication.

## Optional inbox triage

Omit `triage` to retain the approved-sender workflow without classification.
To start in shadow mode, add this to the plugin's `config`:

```json
{
  "triage": {
    "decisionModel": "typesafe/jev-1.13.0",
    "mode": "shadow",
    "observe": "approved",
    "actions": ["label", "wake", "digest"],
    "reviewActions": ["archive", "trash"]
  }
}
```

Install/enable the official `@openclaw/typesafe` plugin with a compatible host
version, configure its protected SecretRef, and set the mailbox agent's
`agents.entries.<agentId>.decisionModel` to exactly the same value. This does **not** change its conversation
model. The plugin checks the selected model before sending evidence and verifies
provider/model provenance afterward. One provider is used, without fallback.
Mail content is shared with that configured provider; obtain owner approval first.

The integration uses the released V1 text/JSON Decisions contract. An OpenAI
Decisions adapter is present on upstream OpenClaw main but was not in the published
2026.10.5 host checked during implementation. OpenAI use requires a supporting
host/provider adapter and Platform API credentials; it is not claimed tested here.

### Permissions and behavior

- `mode: shadow` records assessments/plans only: no Gmail writes or agent runs.
  Switching to `live` affects new work; shadow items require explicit reevaluation.
- `observe: inbox` broadens observation, **not reply authority**. Its activation
  boundary starts when enabled; historical mail is scanned separately for review.
- `actions` is owner authority. `reviewActions` always takes precedence for
  archive/trash, even if the same action is also in `actions`. Default review mode
  never archives or trashes. Removing that protection and adding action authority
  requires an explicit owner config change and restart.
- Mutations target explicit message IDs, preserve read/unread and unrelated labels,
  and create labels only under `Gog/`. No permanent deletion or Trash purge exists.
  Gmail automatically deletes Trash after 30 days.
- Fixed fraud/instruction-attack checks cannot be edited by policy tools. Raw HTML
  is screened, including link targets; links are never fetched. Attachments are not
  scanned: any attachment, missing body, unsupported MIME or oversized evidence
  retains the message for review. This is intentionally conservative.
- Default protected categories are requests, invoices, receipts, scheduling and
  security. `STARRED`/`IMPORTANT` messages cannot be automatically archived/trashed.
  A separate protected-content judgment prevents editable categories bypassing this.
- Thresholds are conservative starting points, **not calibrated accuracy claims**.
  Review real proposals before enabling mailbox dispositions.
- `excludedSenders`/`excludedDomains` skip externally owned workflows before inference;
  this is not an acknowledgment that another workflow received the work.
- Owner `allowedAgents` bounds routing; `policyEditors` bounds policy/review tools
  (both default to the mailbox agent). Policy changes also require trusted owner
  context and are denied in email and delegated subagent sessions.
- The default daily classifier budget is 200. Unavailable/invalid results retain
  mail, retry with backoff and then hold it. No missing judgment is treated as safe.

### Policy and agent tools

`gog_email_policy_get` returns the current version and owner envelope.
`gog_email_policy_preview` compares a candidate against up to 50 cached assessments
without model calls, Gmail writes or dispatch. Threshold-only edits reuse estimates;
new questions/interests/models require new evaluations. `gog_email_policy_update`
uses `expectedVersion` and saves immutable history; restore a previous document by
saving it as a new version. Policy cannot alter the owner envelope.

A policy has `schemaVersion: 1`, `interests`, typed `questions` (boolean, choice,
score), ordered `rules` with `all` conditions, a `default` outcome,
`digestMinutes`, and optional `quietHours: {timezone,start,end}`. Conditions compare
exact facts, choices or numeric thresholds. Outcomes specify `disposition`
(retain/archive/trash), `attention` (none/digest/wake/review), `labels`, and optional
allowed `agentId`. No executable expressions. Get the built-in policy to edit it.

`gog_email_context` gives an active job's messages, reasons, permissions and transcript.
`gog_email_complete` records work completed without email; `gog_email_defer` schedules
a fresh-check retry (Unix seconds, 1 minute–30 days). Neither claims external delivery.
Digests batch metadata/IDs into a separate agent session, without granting reply
authority or including quarantined bodies. Quiet hours defer wake-ups to digests;
digest intervals and quiet windows persist across restarts. No Slack/external digest
delivery is configured automatically.

### Archive/trash review and recovery

```sh
# Assess up to 20 inbox messages from the last week; propose only.
openclaw email-watch archive --review --scan --days 7 --limit 20
openclaw email-watch trash --review
```

These commands call the running Gateway and never apply dispositions. Historical
review saves local assessments but never queues jobs or consumes discovery state.
Output includes message/thread IDs, Gmail links, reasons, coverage and proposed
actions. Results are bounded samples, not a claim that the entire inbox was scanned.
Keep reports private: they contain mailbox metadata.

`gog_email_review` offers `list`, `inspect`, `scan`, `reevaluate`, `close`, `correct`.
`inspect` includes raw estimates and action receipts. `reevaluate` requests a fresh
assessment for an unexecuted hold; it cannot override safeguards. `close` requires
manual reconciliation of a held agent job and a note. It never removes reply
deduplication or retries a send. `correct` saves feedback only—no automatic training
or policy change. The equivalent `gog-email-watch.review` Gateway RPC requires
`operator.admin`. Incoming mail cannot invoke these controls to change policy.

Uncertain mailbox effects are reconciled against Gmail before proceeding. An
uncertain send is never replayed. An unrestricted agent with shell access to the
same credentials can bypass plugin controls; this is not credential isolation.

## Development checks

```sh
npm run preflight
```

Runs TypeScript checks, build, focused tests, static plugin inspection, an
explicit real-SDK registration capture, and a package dry run. The tests use a fake
gog subprocess and real SQLite, including restart/deduplication, rejected mail,
failed sends, and both original regressions: Gmail I/O must not hold a SQLite writer
lock, and uncertain alternate-target sends must not become skipped.
Regression tests also cover mail arriving during a thread fetch and fresh cutoffs
when removed sender/domain rules are re-added.

The static inspector currently reports two evidence gaps (dependency installation
and registration capture); the separate runtime capture proves registration against
the installed SDK. Isolated real-Gateway smoke runs also exercised both reply and
skip using fake Gmail and a local fake model. No live mailbox or paid model was used.

Live Gmail validation and node migration remain separate, authorized deployment
steps. Do not enable this alongside the old watcher for the same mailbox. No fleet
installation is performed by the build, tests, or releases.

Published GitHub Releases trigger npm publication; see [RELEASING.md](https://github.com/unblocklabs-ai/gog-email-watch/blob/main/RELEASING.md).
Licensed under MIT.
