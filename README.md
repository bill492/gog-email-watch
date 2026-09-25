# gog-email-watch

Wake an OpenClaw agent when its Gmail account receives mail from configured
domains or individual addresses, using the node's existing `gog` CLI and credentials.

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
- Failed reads retry on a later poll. Interrupted jobs and uncertain sends remain
  `needs_review` rather than risking duplicate actions; that thread waits for manual review.

Four source modules: `index.ts` (registration), `mail.ts` (gog and mail rules),
`state.ts` (SQLite), and `workflow.ts` (polling and jobs). No daemon, OAuth manager,
queue framework, or separate scheduler. See [scope.md](scope.md) in the source repository.

## Setup

Developed against **OpenClaw 2026.9.2** and Alfie's **gog 0.37.0** command format.
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
