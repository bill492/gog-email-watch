# gog-email-watch scope

## Goal

Port Alfie's working email automation into a reusable OpenClaw plugin. Use each
node's existing gog CLI and credentials, with configurable mailbox, sender domains
and individual email addresses.

Version 0.2 extends the port with the inbox-triage feature in issue #1. Preserve
thread context and reply/skip handling when triage is omitted. When explicitly
enabled, classify mail already present at first enablement as wake, queue, skip or delete.
Skip keeps mail untouched without a wake; independent labeling still applies.
Every message carries its sent date (or a clearly identified Gmail timestamp
fallback), and every Jev request includes the current date and Gateway timezone.
Use one consolidated wake per processing cycle and an agent-configured queue
interval. Independent label definitions (name + description) use a separate Jev
request. Explicit date-range historical scans apply deletion only, never queue,
wake or label. No inference allowance, processing quota, prompt-size/count caps,
forced review or label-prefix restrictions. Jev concurrency defaults to 50 and is
configurable. Preserve existing send receipts and operational recovery.
Agents can read watcher status, inspect unclassified failures and persisted jobs,
and retrieve the latest historical scan's progress/results after a lost response
or restart. Diagnostic reads never reactivate jobs or authorize sends. Explicit
job deferral resumes eligible work independently of the ordinary queue interval.
Policy tools expose both stored settings (including null inheritance) and their
effective values. Reuse the existing service and SQLite state for these surfaces.
The original port constraints below still apply where not superseded by this
explicit feature scope. The saved review/design is in `tmp/2026-10-19-inbox-triage-review-and-plan.md`.

## Keep it lean

Change what is necessary for plugin integration and configuration. Every additional
abstraction, restriction, dependency or recovery mechanism must solve a demonstrated
problem in this workflow, not a hypothetical future requirement.

- Use direct functions and concrete types. Validate config and external data once
  at their boundaries; trust the resulting types inside.
- Reuse OpenClaw's lifecycle and dispatch, and gog's authentication and mail commands.
- Split files when responsibilities warrant it, not to satisfy a predetermined tree.
- No custom hot reload, ownership coordinator, generic retry framework, compatibility
  fallback stack or new permission system. Restart to apply config is sufficient.
- Plugin skills guide packaging and SDK usage; they are not a feature backlog.

## Configuration

Under `plugins.entries.gog-email-watch`:

```json
{
  "enabled": true,
  "config": {
    "account": "agent@example.com",
    "domains": ["example.com"],
    "senders": ["bek@unblocklabs.ai"]
  }
}
```

Domains and addresses are alternatives: at least one must contain an entry for
the new-mail responder. Both may be empty for triage-only use. Match exact parsed
sender domains/addresses, not display names.

Default to agent `main`, a 120-second poll interval, and the existing `gog` on PATH.
Allow overrides for agent, interval, executable path and self-address aliases where
needed. Automatically exclude the configured account itself. One mailbox per node;
reuse existing gog credentials and environment.

## Existing behavior to preserve

- Poll for new mail from configured senders; keep the current authentication,
  self-mail and automated-message exclusions.
- Keep responder activation cutoffs so adding a sender does not send replies to
  their old mail. Backlog triage is separate and explicitly processes old mail.
  Keep overlap and reconciliation for missed new-mail polls.
- Persist message IDs and pending work in SQLite. Do not repeatedly dispatch a
  message because it becomes unread again or the Gateway restarts.
- Batch new messages by thread, retain a stable session per mailbox/thread, and
  give the agent the full chronological conversation, including previous replies.
- Run one mail job at a time while polling continues.
- Preserve reply-in-thread and explicit skip completion, existing recipient
  filtering, and uncertain-send tracking. Adapt the current helper to the plugin
  rather than creating a general-purpose email tool.
- Keep the agent's normal tools and operating judgment. Replace Alfred/Alice-specific
  identities and paths with configuration; do not add approvals or narrow the
  existing reply/scheduling behavior merely because this is becoming a plugin.
- Report errors clearly without logging secrets. Failed reads can retry on the next
  poll. Keep the existing needs-review treatment for uncertain sends/runs instead
  of blindly repeating possible external actions.

The reference is Alfie's `alfred-internal-mail` project. Preserve its useful behavior,
not its Python/launchd plumbing or incidental implementation details.

## Plugin integration

Use native TypeScript and one registered Gateway service. Start polling in service
start, stop it in service stop, and keep SQLite state outside the installed package.
Importing or inspecting the plugin must not start polling.

Use the supported plugin agent-dispatch API instead of spawning the OpenClaw CLI.
The reviewed candidate is `api.runtime.subagent.run()` with `waitForRun()`; verify it
on the target SDK through the actual workflow. Do not reimplement agent/session
management. Final agent output is not itself the email; the reply helper sends it.

Add the normal manifest, compiled entrypoint and focused plugin-inspector checks.
Declare only capabilities actually implemented. Choose dependencies and file layout
during implementation, based on what the port actually needs.

## Fix the two demonstrated bugs

1. Do not hold SQLite write transactions open during Gmail calls.
2. An uncertain reply to an earlier message must not later become "skipped".
   Check send attempts by job, not only by the original target message.

These are concrete corrections, not a mandate for a broader hardening project.

## Validation and finish line

First prove the real path: qualifying email → thread context → agent run → reply or
skip. Test the small set of failures we care about: rejected sender, duplicate mail,
restart, gog failure and uncertain send, including the two regressions above.

Use isolated state and controlled mail fixtures during development. A live send or
node migration requires separate authorization. Run the relevant build, package and
behavior checks; once they pass, stop unless something changed or still looks wrong.
Do not add tests for coverage or implementation details.

Reuse the host Decisions runtime; no plugin-owned provider transports. No
multi-account framework, dashboard, OAuth setup, Pub/Sub,
standalone daemon or fleet orchestration. Installation on Alfie and other nodes is
a later step; do not replace their running automation during development.
