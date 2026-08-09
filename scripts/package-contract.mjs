import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PI_CORE_PEERS = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

function normalizePackagePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function readPackageManifest() {
  return JSON.parse(
    readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );
}

function runPackDryRun() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["pack", "--dry-run", "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === "win32",
    timeout: 30_000,
  });

  if (result.error) {
    throw new Error(`Unable to run ${npmCommand}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${npmCommand} pack --dry-run failed:\n${result.stderr || result.stdout}`,
    );
  }

  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Unable to parse npm pack output: ${error instanceof Error ? error.message : String(error)}\n${result.stdout}`,
    );
  }

  const files = output?.[0]?.files;
  assert(Array.isArray(files), "npm pack output did not contain a files list");
  return new Set(files.map((file) => normalizePackagePath(file.path)));
}

function collectProductionTypeScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectProductionTypeScriptFiles(absolutePath));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !/(?:\.test|\.spec)\.ts$/i.test(entry.name)
    ) {
      files.push(normalizePackagePath(path.relative(projectRoot, absolutePath)));
    }
  }
  return files;
}

function assertIncluded(packagedFiles, filePath, reason) {
  const normalized = normalizePackagePath(filePath);
  assert(
    packagedFiles.has(normalized),
    `Package is missing ${normalized}${reason ? ` (${reason})` : ""}`,
  );
}

function assertPiCorePeerDependencies(manifest) {
  for (const packageName of PI_CORE_PEERS) {
    assert.equal(
      manifest.peerDependencies?.[packageName],
      "*",
      `${packageName} must use the official '*' peer dependency range`,
    );
  }
}

function assertManifestEntries(packagedFiles, manifest) {
  const piManifest = manifest.pi;
  assert(piManifest && typeof piManifest === "object", "package.json is missing the pi manifest");

  for (const [key, label] of [["themes", "pi.themes"], ["extensions", "pi.extensions"]]) {
    assert(Array.isArray(piManifest[key]) && piManifest[key].length > 0, `${label} must be a non-empty array`);
  }

  for (const themePath of piManifest.themes) {
    assert(typeof themePath === "string" && themePath.length > 0, "pi.themes entries must be non-empty strings");
    assertIncluded(packagedFiles, themePath, "declared by pi.themes");
  }

  for (const extensionPath of piManifest.extensions) {
    assert(typeof extensionPath === "string" && extensionPath.length > 0, "pi.extensions entries must be non-empty strings");
    const normalized = normalizePackagePath(extensionPath);
    assert(!normalized.startsWith("../") && !path.isAbsolute(normalized), `Invalid pi.extensions path: ${extensionPath}`);
    const absolutePath = path.join(projectRoot, normalized);
    if (existsSync(absolutePath) && statSync(absolutePath).isDirectory()) {
      assertIncluded(packagedFiles, `${normalized}/index.ts`, "extension directory entry");
    } else {
      assertIncluded(packagedFiles, normalized, "declared by pi.extensions");
    }
  }
}

function main() {
  const manifest = readPackageManifest();
  const packagedFiles = runPackDryRun();

  for (const requiredFile of [
    "LICENSE",
    "README.md",
    "assets/screenshot.png",
    "themes/tokyo-night-dark.json",
    "themes/tokyo-night-light.json",
  ]) {
    assertIncluded(packagedFiles, requiredFile, "required package asset");
  }

  for (const sourceFile of collectProductionTypeScriptFiles(path.join(projectRoot, "extensions"))) {
    assertIncluded(packagedFiles, sourceFile, "production extension source");
  }

  for (const packagedFile of packagedFiles) {
    assert(
      !/(^|\/)(?:[^/]+\.(?:test|spec)\.[^/]+|tests?|__tests__)(?:\/|$)/i.test(packagedFile),
      `Package must not contain test files: ${packagedFile}`,
    );
    assert(
      !packagedFile.startsWith("node_modules/"),
      `Package must not contain node_modules: ${packagedFile}`,
    );
  }

  assertPiCorePeerDependencies(manifest);
  assertManifestEntries(packagedFiles, manifest);
  console.log(`Package contract passed (${packagedFiles.size} files).`);
}

main();
