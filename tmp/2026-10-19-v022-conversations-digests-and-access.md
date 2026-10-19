# v0.2.2: conversation wakes, digest cadence, simpler access

## Changes

- New `conversationReply` fact requires an earlier Gmail `SENT` message from the
  account or configured alias in the same thread. The default policy wakes for
  these replies without requiring another actionable request.
- `triage.wakeOnExternalReplies` is opt-in, defaults false, and permits wakes only.
  Sender authentication, automation exclusions and safety checks still apply;
  sending still requires an approved sender. Enablement has its own fresh cutoff.
- `policy.digestMinutes` controls minimum spacing between digest runs per agent,
  including pending mail. It uses existing durable jobs; no new timer or table.
- Policy/review tools no longer check owner context, agent allowlists or session
  type. `policyEditors` is accepted but ignored for existing-config compatibility.
  Agent identity remains audit metadata, not an edit gate. Version/schema checks
  remain. Email content is evidence, not authority to change configuration.
- Removed forced 0600/0700 modes from plugin-created files/directories. Normal
  process umask applies; no automatic chmod migration on service startup.
- Provider, sender rules, routing destinations and permitted mail actions remain
  ordinary plugin configuration. No unrelated credential permissions are changed.

## Review and validation before release

- Reviewed runtime, policy, entry-point, manifest and documentation diffs.
- Updated the real service/tool/SQLite test to exercise non-owner policy updates
  from ordinary, delegated and email sessions. It failed on the old editor gate,
  then passed after removal. The obsolete denial-only test was deleted (Git history
  retains it). Optimistic concurrency and invalid-policy checks remain covered.
- Full preflight passed: TypeScript, build/schema sync, all 25 tests, static plugin
  inspection, real-SDK registration capture and npm package dry-run.
- Static inspector: zero breakages; two existing evidence gaps are addressed by
  the separate runtime capture and installed-runtime validation.
- Other regression scenarios cover participated threads, external opt-in/off/on
  cutoffs, no external send authority, digest batching/restart/cadence changes,
  stale cached facts, uncertain sends and review-only historical scans.
- Release versions agree at 0.2.2. No additional scheduler, service, RPC, dependency
  or production-only test hook was introduced.

## Bill rollout plan

Back up the current config, service definition and database; install the exact
npm release; verify live runtime provenance. Use the existing policy tool to add
the conversation rule without replacing his policy. Preserve approved senders,
live/approved observation, 1440-minute digest cadence, disabled external wakes and
review-only archive/trash. Normalize only this plugin's existing state/transcript
modes to ordinary 0755/0644. Scan real inbox mail in review-only mode and verify no
test-created jobs, sends or mailbox mutations. Do not replay old mail to force a
wake or send a synthetic test email.

Release and deployment evidence will be appended after completion.
