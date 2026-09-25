import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const tag = process.argv[2] ?? process.env.RELEASE_TAG;
assert.match(tag ?? "", /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Expected vX.Y.Z or vX.Y.Z-prerelease");
const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
const pkg = read("package.json"), manifest = read("openclaw.plugin.json"), lock = read("package-lock.json");
assert.equal(pkg.name, "@unblocklabs/gog-email-watch");
for (const version of [pkg.version, manifest.version, lock.version, lock.packages[""].version]) {
  assert.equal(version, tag.slice(1), "Release tag and package versions must match");
}
console.log(`Release versions match: ${tag}`);
