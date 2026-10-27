import { readFile, access, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const manifest = JSON.parse(await readFile(new URL("../module.json", import.meta.url), "utf8"));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(manifest.id, pkg.name);
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.socket, true);
assert.ok(manifest.relationships.requires.some(entry => entry.id === "socketlib"));
for (const file of [...manifest.esmodules, ...manifest.styles]) await access(new URL(`../${file}`, import.meta.url));
for (const file of await readdir(new URL("./", import.meta.url))) {
  if (!/\.m?js$/.test(file)) continue;
  const result = spawnSync(process.execPath, ["--check", new URL(file, import.meta.url).pathname], { stdio: "inherit" });
  assert.equal(result.status, 0, `${file} must parse`);
}
console.log("Manifest, entry points, and JavaScript syntax checked.");
