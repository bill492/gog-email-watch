# v0.3.5 release and Bill rollout

Date: 2026-10-19 (America/New_York; 2026-10-20 UTC).
Status: released to npm and installed on Bill; watcher remains paused.

## Release

- Release commit: `ccc5e665ef397ba6bd6f46fe24e333ca22fe5e3c`.
- Tag: `v0.3.5`, verified against the remote commit.
- [GitHub release](https://github.com/unblocklabs-ai/gog-email-watch/releases/tag/v0.3.5).
- [CI](https://github.com/unblocklabs-ai/gog-email-watch/actions/runs/39364983885): passed.
- [Release workflow](https://github.com/unblocklabs-ai/gog-email-watch/actions/runs/39365116169): passed.
- npm: `@unblocklabs/gog-email-watch@0.3.5`, verified as `latest`, with GitHub Actions provenance.
- Published tarball integrity matches the local Node 24 / npm 11.13.0 package and Bill's installed source:

  `sha512-O6CUELTXZ6ia4MD9ETie4j3FmVagZP0y0R6xqc7P4YfLI/SQ4KbsgTrjjLNrUwKReHZ4XS92OxQDvL8oJEB+Gw==`

Registry metadata briefly lagged successful publication. Installation waited until
the exact version was available and its integrity matched; `latest` subsequently
confirmed 0.3.5.

## Validation

The version check and full preflight passed after the version bump on Node
24.21.0: typecheck, build/manifest, **51 passing tests**, static plugin inspection,
real-SDK registration capture and npm package preview. CI and the release workflow
also passed their preflights. `git diff --check` passed.

The static inspector reported no breakages. Its existing generic proof gaps concern
isolated dependency installation and registrar capture; the separate real-SDK
capture and installed-entrypoint import provide additional evidence, not a claim
that the inspector itself closed those gaps.

The implementation, real-mail dry-run results and three review fixes are documented
in [the benchmark report](2026-10-19-rolling-triage-benchmark.md).

## Bill

- Fresh configuration, service-definition and SQLite backups saved before installation.
- Native install:
  `openclaw plugins install npm:@unblocklabs/gog-email-watch@0.3.5 --pin --force --accept-capabilities --no-enable`.
- Installer applied Gateway generation **22** without a restart.
- Live Gateway `plugins.inspect` returned version **0.3.5** and the expected npm integrity.
- CLI runtime inspection reported the plugin disabled, with no diagnostics.
- The exact installed JavaScript entrypoint imported successfully in a separate
  Node process, without registering or starting its service.
- Gateway RPC remained healthy; the Gateway PID was unchanged.
- Plugin configuration and unrelated configuration were compared to the backup;
  saved policy, credentials and deletion-off setting were preserved.
- Gateway service definition was byte-identical.
- All rows in the ten live mail-state tables were unchanged. Existing counts
  remained 70 done, 342 queue and 359 pending; the earlier dry-run counts were
  never written into this database.

The existing Gateway service-definition warning was present before and after the
update and was not repaired as part of this plugin rollout.

No watcher activation, live mailbox scan, wake, email send, label application or
deletion was performed. A paused install and successful import do not prove active
mail polling or live wake delivery. Existing custom prompt text was not replaced
with the new built-in default.

OpenClaw plugin skills guided native installation, package-integrity verification
and the distinction between installed code and a running watcher.
Private mail content, IDs, credentials and raw configuration backups are excluded.
