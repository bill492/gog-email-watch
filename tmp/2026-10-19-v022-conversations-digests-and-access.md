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

## Release and Bill deployment evidence

- Release commit/tag: `13732fba37cba9b09947757b8c301817c827e99e`, `v0.2.2`.
- CI [39323487963](https://github.com/unblocklabs-ai/gog-email-watch/actions/runs/39323487963)
  and release [39323609592](https://github.com/unblocklabs-ai/gog-email-watch/actions/runs/39323609592)
  both passed. [GitHub release](https://github.com/unblocklabs-ai/gog-email-watch/releases/tag/v0.2.2).
- npm accepted publication with HTTP 202; public availability followed after
  processing. No duplicate publication was attempted.
- Downloaded npm tarball matches the locally built release. SHA1:
  `a4a551c17ab1dad74d376ec1dd426a1d447b3ec1`.
  Integrity: `sha512-YKztgSa9IReUirx9lwzdp0jmYY7yy3OS8ubLWJf+GMgrmYoozGD5QYek6gozbTca4ifjQuGU3xtYUh3ibxy2ag==`.
  Published provenance binds that artifact to the release commit and
  `.github/workflows/release.yml` at `refs/tags/v0.2.2`.
- Bill installed the pinned npm package with `--force --no-enable
  --accept-capabilities`. Replacement waited for retained work and applied in
  Gateway generation 5. No Gateway restart or service-definition change occurred.
- Live Gateway `plugins.list` reports the watcher **active**, version 0.2.2;
  `plugins.inspect` reports the exact npm source and integrity above. Gateway RPC
  is healthy, same PID/boot ID. CLI import inspection separately has no diagnostics.
- Important diagnostic distinction: `plugins inspect --runtime` loads a separate
  CLI runtime and showed a false credential-unavailable result. The actual Gateway
  `plugins.inspect` RPC reports Jev credential-ready and callable. No credential
  repair or restart was needed.
- Existing policy v1 was previewed, then updated through `tools.invoke` and
  `gog_email_policy_update` to v2, adding only the conversation rule. A subsequent
  get confirmed persistence. Digest cadence remains 1440 minutes, external-reply
  wakes remain false, sender rules and live/approved triage remain unchanged.
- Normalized 7 plugin-state directories and 11 files to 0755/0644, including
  existing transcripts and SQLite files. Original modes are in the scoped backup.
  No credential or unrelated files were chmodded.
- Scoped backup: `~/.openclaw/backups/gog-email-watch-0.2.2-20261019` on Bill.
  Config, service definition, original state modes and SQLite snapshot retained.

### Real-mail validation

The first bounded scan sampled 50 real inbox emails from 30 days (more mail exists):
49 assessments and one already-tracked item. It reused 33 successful assessments
and made 16 new Jev requests: 14 succeeded, two returned transport-unavailable and
were held for review. Plans: 29 digest, 18 review holds, two trash proposals.
Archive/trash review commands both ran without applying changes.

No participated-thread reply was present in this sample. The real scan validates
Gmail retrieval, Jev integration, cached-policy evaluation and review controls;
conversation dispatch and digest timing are proved by the local end-to-end
regressions, not a forced wake from historical mail.

Verification confirmed the original 10 message records, four jobs, zero replies
and zero effects are unchanged. Activation cutoff, all plugin/agent/provider/secret
configuration and the service definition are preserved; a fresh scheduled poll
finished without error. All 49 assessed rows have current conversation facts.

After the normal five-minute failure cache expired, a second scan retried the two
unavailable assessments. Both again returned `transport`; their conservative review
holds remain. Final results are unchanged: 47 successful assessments, two unavailable,
one already tracked. This is an observed provider limitation, not an all-successful
classification claim. No additional retry framework or credential changes were added.

Final private evidence is retained on Bill under
`~/.openclaw-gog-triage-canary-20261019/`: `v022-real-scan.json`,
`v022-retry-scan.json`, both `v022-retry-*-review.json` reports,
`v022-live-plugin-list.json`, `v022-live-watcher.json`, `v022-live-typesafe.json`,
`v022-gateway-status.json`, `v022-policy.json`, `v022-final-summary.json` and
`v022-final-verification.json`. No message subjects, bodies, credentials or raw
assessment output are committed to the public repository.
