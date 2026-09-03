import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const EXACT_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const PI_CORE_PACKAGES = Object.freeze([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
]);

export const COMPATIBILITY_PROJECT_ENTRIES = Object.freeze([
  ".github",
  "assets",
  "extensions",
  "scripts",
  "themes",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "package.json",
  "tsconfig.json",
  "vitest.config.ts",
]);

export function createCompatibilityManifest(piVersion) {
  return {
    private: true,
    dependencies: Object.fromEntries(
      PI_CORE_PACKAGES.map((packageName) => [packageName, piVersion]),
    ),
  };
}

export function createRuntimeInstallCommand(
  runtimeRoot,
  platform = process.platform,
) {
  return {
    command: platform === "win32" ? "npm.cmd" : "npm",
    args: [
      "install",
      "--package-lock=false",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    cwd: runtimeRoot,
  };
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    timeout: COMMAND_TIMEOUT_MS,
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(`${command} ${args.join(" ")} timed out`);
    }
    throw result.error;
  }
  if (result.signal) {
    throw new Error(
      `${command} ${args.join(" ")} exited with signal ${result.signal}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with code ${result.status}`,
    );
  }
}

async function readProjectManifest() {
  return JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
  );
}

async function resolvePiVersion() {
  const manifest = await readProjectManifest();
  const requested = process.argv[2]?.trim() ||
    process.env.PI_COMPAT_VERSION?.trim() ||
    manifest.devDependencies?.["@earendil-works/pi-coding-agent"];

  if (typeof requested !== "string" || !EXACT_VERSION_PATTERN.test(requested)) {
    throw new Error(
      "Pi compatibility check requires an exact version such as 0.82.0",
    );
  }
  return requested;
}

async function copyProject(targetDirectory) {
  await mkdir(targetDirectory, { recursive: true });
  for (const entry of COMPATIBILITY_PROJECT_ENTRIES) {
    await cp(
      path.join(projectRoot, entry),
      path.join(targetDirectory, entry),
      { recursive: true },
    );
  }
}

async function assertInstalledPiVersions(runtimeRoot, piVersion) {
  for (const packageName of PI_CORE_PACKAGES) {
    const installedManifest = JSON.parse(
      await readFile(
        path.join(runtimeRoot, "node_modules", packageName, "package.json"),
        "utf8",
      ),
    );
    assert.equal(
      installedManifest.version,
      piVersion,
      `${packageName} installed ${installedManifest.version}, expected ${piVersion}`,
    );
  }
}

async function resolveToolPath(...segments) {
  const toolPath = path.join(projectRoot, "node_modules", ...segments);
  try {
    await access(toolPath);
  } catch {
    throw new Error(
      `Missing ${toolPath}. Run npm ci before the compatibility check.`,
    );
  }
  return toolPath;
}

export async function main() {
  const piVersion = await resolvePiVersion();
  const typeScriptPath = await resolveToolPath("typescript", "bin", "tsc");
  const vitestPath = await resolveToolPath("vitest", "vitest.mjs");
  const temporaryRoot = await mkdtemp(
    path.join(projectRoot, ".pi-compat-"),
  );
  const compatibilityProject = path.join(temporaryRoot, "project");

  try {
    await writeFile(
      path.join(temporaryRoot, "package.json"),
      `${JSON.stringify(createCompatibilityManifest(piVersion), null, 2)}\n`,
      "utf8",
    );
    const installCommand = createRuntimeInstallCommand(temporaryRoot);
    runCommand(
      installCommand.command,
      installCommand.args,
      installCommand.cwd,
    );
    await assertInstalledPiVersions(temporaryRoot, piVersion);
    await copyProject(compatibilityProject);

    runCommand(
      process.execPath,
      [
        typeScriptPath,
        "--project",
        path.join(compatibilityProject, "tsconfig.json"),
        "--noEmit",
      ],
      compatibilityProject,
    );
    runCommand(
      process.execPath,
      [vitestPath, "run"],
      compatibilityProject,
    );
    runCommand(
      process.execPath,
      [path.join(compatibilityProject, "scripts", "package-contract.mjs")],
      compatibilityProject,
    );

    console.log(`Pi ${piVersion} isolated compatibility check passed.`);
  } finally {
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
