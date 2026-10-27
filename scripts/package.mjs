import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zipSync, unzipSync } from "fflate";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

/** Create a reproducible, directly installable archive without development files. */
export async function buildRelease({ root = projectRoot, output = join(root, "dist") } = {}) {
  const manifest = JSON.parse(await readFile(join(root, "module.json"), "utf8"));
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.id, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.match(manifest.id, /^[a-z0-9-]+$/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);

  // Runtime JavaScript lives in .js files; Node-only tooling lives in .mjs files.
  const scripts = (await readdir(join(root, "scripts"), { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(".js"))
    .map(entry => `scripts/${entry.name}`);
  const files = [...new Set(["module.json", "README.md", ...scripts,
    ...(manifest.esmodules ?? []), ...(manifest.styles ?? [])])].sort();
  const entries = {};
  for (const name of files) {
    assert.ok(!name.startsWith("/") && !name.split(/[\\/]/).includes(".."), `Invalid release path: ${name}`);
    entries[name] = await readFile(join(root, name));
  }
  const bytes = zipSync(entries, { level: 9, mtime: new Date(2000, 0, 1) });
  // Catch missing or changed archive entries before writing a release artifact.
  const extracted = unzipSync(bytes);
  assert.deepEqual(Object.keys(extracted).sort(), files);
  for (const name of files) assert.deepEqual(Buffer.from(extracted[name]), entries[name]);

  const filename = `${manifest.id}-${manifest.version}.zip`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, filename), bytes);
  await writeFile(join(output, "module.json"), entries["module.json"]);
  await writeFile(join(output, "SHA256SUMS"), `${sha256}  ${filename}\n`);
  return { archive: join(output, filename), filename, sha256, files, size: bytes.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const release = await buildRelease();
  console.log(`Packaged ${release.files.length} files (${release.size} bytes): ${release.archive}`);
  console.log(`SHA-256: ${release.sha256}`);
}
