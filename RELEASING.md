# Releasing

Like `unblock-memory` and `unblock-codex-prompt`, a **published GitHub Release**
triggers npm publication. Pushes and pull requests run checks only.

- GitHub: `unblocklabs-ai/gog-email-watch` (public)
- npm: `@unblocklabs/gog-email-watch` (public)
- ClawHub: not configured

## One-time npm setup

An owner of the `@unblocklabs` npm scope must bootstrap the first package version:

```sh
npm login --registry=https://registry.npmjs.org
npm run preflight
npm publish --access public
```

Then configure GitHub Actions as the package's trusted publisher:

```sh
npx --yes --package npm@12.0.2 npm trust github @unblocklabs/gog-email-watch --repo unblocklabs-ai/gog-email-watch --file release.yml --allow-publish --yes
```

Alternatively, use the package's npm settings: GitHub owner `unblocklabs-ai`,
repository `gog-email-watch`, workflow `release.yml`, no environment name.
No npm token is stored in GitHub. New versions use OIDC and provenance; the first
local bootstrap does not have GitHub Actions provenance. A workflow rerun accepts
an already-published version only when its tarball integrity matches exactly.

## Each release

1. Update versions together in `package.json`, `package-lock.json` (root and root
   package entry), and `openclaw.plugin.json`.
2. Run `npm run release:check -- vX.Y.Z` and `npm run preflight`.
3. Commit and push to `main`; wait for CI to pass.
4. Tag that commit `vX.Y.Z`, push the tag, and publish its GitHub Release with notes.
5. Wait for the Release workflow; verify the npm version and integrity, and that
   the tag references the intended commit. A failed npm job is not a completed release.

The workflow publishes `latest` for normal releases and `next` for prereleases.
Releasing never installs on fleet nodes or replaces an existing email watcher.
