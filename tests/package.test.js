import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { buildRelease } from "../scripts/package.mjs";

test("the release ZIP is reproducible, complete, and excludes development files", async t => {
  const output = await mkdtemp(join(tmpdir(), "hero-coin-release-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const first = await buildRelease({ output });
  const bytes = await readFile(first.archive);
  const files = unzipSync(bytes);
  const manifest = JSON.parse(Buffer.from(files["module.json"]).toString("utf8"));
  assert.equal(manifest.id, "hero-point-handle-bars");
  assert.equal(first.filename, `${manifest.id}-${manifest.version}.zip`);
  for (const entry of [...manifest.esmodules, ...manifest.styles]) assert.ok(files[entry], entry);
  for (const entry of ["scripts/coin.js", "scripts/hand.js", "scripts/rules.js", "scripts/service.js", "README.md"]) assert.ok(files[entry], entry);
  assert.ok(Object.keys(files).every(name => !/node_modules|package-lock|AGENTS|tests\/|dev\/|\.mjs$/.test(name)));
  assert.deepEqual(await readFile(join(output, "module.json")), Buffer.from(files["module.json"]));
  assert.equal(await readFile(join(output, "SHA256SUMS"), "utf8"), `${first.sha256}  ${first.filename}\n`);
  const second = await buildRelease({ output });
  assert.equal(second.sha256, first.sha256);
  assert.deepEqual(await readFile(second.archive), bytes);
});
