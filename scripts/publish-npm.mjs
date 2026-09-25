import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Supports the initial authenticated bootstrap and workflow reruns without
// treating an unrelated, already-published artifact as a successful release.
const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts"], { encoding: "utf8" }));
assert.equal(pack.name, "@unblocklabs/gog-email-watch");
const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pack.name)}/${encodeURIComponent(pack.version)}`);
if (response.ok) {
  const published = await response.json();
  assert.equal(published.dist.integrity, pack.integrity, "Published artifact differs from this release");
  console.log(`Verified identical published artifact: ${pack.name}@${pack.version}`);
} else {
  assert.equal(response.status, 404, `Registry lookup failed: HTTP ${response.status}`);
  execFileSync("npm", ["publish", pack.filename, "--access", "public", "--provenance", "--tag", process.env.NPM_TAG ?? "latest"], { stdio: "inherit" });
}
