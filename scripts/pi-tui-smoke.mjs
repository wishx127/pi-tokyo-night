import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 180_000;
const FIRST_FRAME_TIMEOUT_MS = 15_000;
const STUDIO_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 10_000;

export const SMOKE_SCENARIOS = Object.freeze([
  Object.freeze({
    name: "dark-wide",
    theme: "tokyo-night-dark",
    iconMode: "nerd",
    columns: 100,
    rows: 30,
  }),
  Object.freeze({
    name: "light-wide",
    theme: "tokyo-night-light",
    iconMode: "nerd",
    columns: 100,
    rows: 30,
  }),
  Object.freeze({
    name: "ascii-narrow",
    theme: "tokyo-night-dark",
    iconMode: "ascii",
    columns: 40,
    rows: 24,
  }),
]);

export function createFixtureManifest(tarballSpec, piVersion) {
  return {
    private: true,
    dependencies: {
      "@earendil-works/pi-ai": piVersion,
      "@earendil-works/pi-coding-agent": piVersion,
      "@earendil-works/pi-tui": piVersion,
      "@wishx127/pi-tokyo-night": tarballSpec,
    },
  };
}

export function createAgentSettings(scenario, installedPackageRoot) {
  return {
    theme: scenario.theme,
    packages: [installedPackageRoot],
  };
}

export function createScenarioConfig(scenario) {
  return {
    panel: true,
    editorFrame: true,
    codexQuota: false,
    kimiQuota: false,
    iconMode: scenario.iconMode,
    statusModules: {
      model: true,
      thinking: true,
      path: true,
      git: true,
      quota: true,
      tokens: true,
      cost: true,
      context: true,
    },
    rainMode: "auto",
    rainRows: 3,
    rainTickMs: 130,
    maxRainDrops: 25,
  };
}

export function createScenarioCheckpoints(scenario) {
  const themeCheckpoint = scenario.theme === "tokyo-night-light"
    ? "Theme: Tokyo Night Light"
    : "Theme: Tokyo Night Dark";
  const statusIconCheckpoint = scenario.iconMode === "ascii"
    ? " @ "
    : " \uE795 ";
  const iconSettingCheckpoint = scenario.iconMode === "ascii"
    ? "Status Icons: ASCII"
    : "Status Icons: Nerd";
  return [
    "🌙",
    statusIconCheckpoint,
    "Neon Studio",
    themeCheckpoint,
    iconSettingCheckpoint,
  ];
}

const FATAL_OUTPUT_MARKERS = Object.freeze([
  "uncaughtException",
  "Maximum call stack size exceeded",
  "UnhandledPromiseRejection",
  "ERR_MODULE_NOT_FOUND",
  "Cannot find module",
  "SyntaxError:",
  "TypeError:",
  "RangeError:",
  "ReferenceError:",
]);

const EXTENSION_ERROR_LOG_PATTERN =
  /^\[[^\]\r\n]+\]\s+ERROR(?:\s|$)/m;

export function assertSmokeExit(result, label = "Pi TUI smoke") {
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(`${label} timed out`);
    }
    throw result.error;
  }

  if (result.signal) {
    throw new Error(`${label} exited with signal ${result.signal}`);
  }

  const status = result.status ?? result.code;
  if (status !== 0) {
    throw new Error(`${label} exited with code ${status ?? "unknown"}`);
  }
}

export function assertOrderedCheckpoints(output, checkpoints) {
  let offset = 0;
  for (const checkpoint of checkpoints) {
    const index = output.indexOf(checkpoint, offset);
    if (index === -1) {
      throw new Error(`missing ordered checkpoint ${JSON.stringify(checkpoint)}`);
    }
    offset = index + checkpoint.length;
  }
}

export function assertOutputWithinLimit(exceeded, label = "Pi TUI smoke") {
  if (exceeded) throw new Error(`${label} exceeded the output limit`);
}

export function assertNoFatalOutput(output, extensionLog = "") {
  for (const marker of FATAL_OUTPUT_MARKERS) {
    if (output.includes(marker)) {
      throw new Error(`Pi TUI smoke contains fatal output ${JSON.stringify(marker)}`);
    }
  }
  if (EXTENSION_ERROR_LOG_PATTERN.test(extensionLog)) {
    throw new Error("Pi TUI smoke extension log contains an error");
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function timeoutError(message) {
  return Object.assign(new Error(message), { code: "ETIMEDOUT" });
}

function signalProcess(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Fall back to the process when it is not a process-group leader.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // The process may already have exited.
  }
}

function terminateProcessGroup(child, signal = "SIGTERM") {
  signalProcess(child.pid, signal);
}

async function readProcessId(filePath) {
  try {
    const value = Number.parseInt(await readFile(filePath, "utf8"), 10);
    return Number.isInteger(value) && value > 1 ? value : undefined;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function stopPtySession(session) {
  const cleanExit = session.outcome &&
    !session.outcome.error &&
    !session.outcome.signal &&
    session.outcome.status === 0;
  if (cleanExit && !session.overflow) return;

  const innerPid = await readProcessId(session.innerPidPath);
  signalProcess(innerPid, "SIGTERM");
  terminateProcessGroup(session.child, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  signalProcess(innerPid, "SIGKILL");
  terminateProcessGroup(session.child, "SIGKILL");
  await Promise.race([
    session.exitPromise,
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
}

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function runCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += stdoutDecoder.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += stderrDecoder.write(chunk);
  });

  const result = await new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve(value);
    };
    const timer = setTimeout(() => {
      terminateProcessGroup(child);
      setTimeout(() => terminateProcessGroup(child, "SIGKILL"), 500).unref();
      settle({ error: timeoutError(`${command} timed out`) });
    }, options.timeout ?? COMMAND_TIMEOUT_MS);

    child.once("error", (error) => settle({ error }));
    child.once("close", (status, signal) => settle({ status, signal }));
  });

  try {
    assertSmokeExit(result, command);
  } catch (error) {
    const detail = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${
        detail ? `\n${detail}` : ""
      }`,
      { cause: error },
    );
  }
  return { stdout, stderr };
}

async function resolvePiVersion() {
  if (process.env.PI_COMPAT_VERSION?.trim()) {
    return process.env.PI_COMPAT_VERSION.trim();
  }
  const manifest = JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
  );
  return manifest.devDependencies["@earendil-works/pi-coding-agent"];
}

async function installPackedFixture(temporaryRoot, piVersion) {
  const packDirectory = path.join(temporaryRoot, "pack");
  const fixtureDirectory = path.join(temporaryRoot, "fixture");
  await mkdir(packDirectory, { recursive: true });
  await mkdir(fixtureDirectory, { recursive: true });

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = await runCommand(
    npmCommand,
    ["pack", "--json", "--pack-destination", packDirectory],
    { cwd: projectRoot },
  );
  let packResult;
  try {
    packResult = JSON.parse(packed.stdout);
  } catch (error) {
    throw new Error(`Could not parse npm pack output:\n${packed.stdout}`, {
      cause: error,
    });
  }
  const filename = packResult?.[0]?.filename;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("npm pack did not report a tarball filename");
  }
  const tarballPath = path.join(packDirectory, filename);
  await access(tarballPath);

  const fixtureManifest = createFixtureManifest(
    pathToFileURL(tarballPath).href,
    piVersion,
  );
  await writeFile(
    path.join(fixtureDirectory, "package.json"),
    JSON.stringify(fixtureManifest, null, 2),
    "utf8",
  );
  await runCommand(
    npmCommand,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
    ],
    { cwd: fixtureDirectory },
  );

  const installedPackageRoot = await realpath(
    path.join(
      fixtureDirectory,
      "node_modules",
      "@wishx127",
      "pi-tokyo-night",
    ),
  );
  const realFixtureDirectory = await realpath(fixtureDirectory);
  if (!installedPackageRoot.startsWith(`${realFixtureDirectory}${path.sep}`)) {
    throw new Error(
      `Smoke package was not installed inside the fixture: ${installedPackageRoot}`,
    );
  }

  for (const packageName of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
  ]) {
    const installedManifest = JSON.parse(
      await readFile(
        path.join(fixtureDirectory, "node_modules", packageName, "package.json"),
        "utf8",
      ),
    );
    if (piVersion !== "latest" && installedManifest.version !== piVersion) {
      throw new Error(
        `${packageName} installed ${installedManifest.version}, expected ${piVersion}`,
      );
    }
  }

  const piExecutablePath = path.join(
    fixtureDirectory,
    "node_modules",
    ".bin",
    "pi",
  );
  await Promise.all([
    access(path.join(installedPackageRoot, "package.json")),
    access(piExecutablePath),
  ]);

  return {
    installedPackageRoot,
    piExecutablePath,
  };
}

function createPtySession(command, options) {
  const child = spawn(
    "script",
    [
      "--quiet",
      "--return",
      "--flush",
      "--command",
      command,
      "/dev/null",
    ],
    {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let output = "";
  let outputBytes = 0;
  let overflow = false;
  let outcome;

  const append = (chunk, decoder) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      overflow = true;
      terminateProcessGroup(child);
      return;
    }
    output += decoder.write(chunk);
  };
  child.stdout.on("data", (chunk) => append(chunk, stdoutDecoder));
  child.stderr.on("data", (chunk) => append(chunk, stderrDecoder));

  const exitPromise = new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      output += stdoutDecoder.end();
      output += stderrDecoder.end();
      outcome = result;
      resolve(result);
    };
    child.once("error", (error) => settle({ error }));
    child.once("close", (status, signal) => settle({ status, signal }));
  });

  return {
    child,
    exitPromise,
    get outcome() {
      return outcome;
    },
    get output() {
      return output;
    },
    innerPidPath: options.innerPidPath,
    get overflow() {
      return overflow;
    },
  };
}

async function waitForText(session, expected, timeoutMs, stage) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertOutputWithinLimit(session.overflow, stage);
    if (session.output.includes(expected)) return;
    if (session.outcome) {
      assertSmokeExit(session.outcome, stage);
      throw new Error(`${stage} exited before rendering ${JSON.stringify(expected)}`);
    }
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 25)),
      session.exitPromise,
    ]);
  }
  throw timeoutError(`${stage} timed out waiting for ${JSON.stringify(expected)}`);
}

async function waitForExit(session, timeoutMs, label) {
  let timer;
  const result = await Promise.race([
    session.exitPromise,
    new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ error: timeoutError(`${label} timed out`) }),
        timeoutMs,
      );
    }),
  ]);
  clearTimeout(timer);
  assertSmokeExit(result, label);
}

function writeInput(session, input, stage) {
  if (session.outcome) {
    assertSmokeExit(session.outcome, stage);
    throw new Error(`${stage} exited before accepting input`);
  }
  session.child.stdin.write(input);
}

function outputTail(output, maximumLength = 16_000) {
  return output.length <= maximumLength
    ? output
    : `[...output truncated...]\n${output.slice(-maximumLength)}`;
}

async function runScenario(fixture, temporaryRoot, scenario) {
  const scenarioRoot = path.join(temporaryRoot, "runs", scenario.name);
  const agentDirectory = path.join(scenarioRoot, "agent");
  const extensionConfigDirectory = path.join(agentDirectory, "extensions");
  const homeDirectory = path.join(scenarioRoot, "home");
  await Promise.all([
    mkdir(extensionConfigDirectory, { recursive: true }),
    mkdir(homeDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(agentDirectory, "settings.json"),
      JSON.stringify(
        createAgentSettings(scenario, fixture.installedPackageRoot),
        null,
        2,
      ),
      "utf8",
    ),
    writeFile(
      path.join(extensionConfigDirectory, "pi-tokyo-night.json"),
      JSON.stringify(createScenarioConfig(scenario), null, 2),
      "utf8",
    ),
  ]);

  const innerPidPath = path.join(scenarioRoot, "pi.pid");
  const piArguments = ["--offline", "--no-session"];
  const shellCommand = [
    `printf '%s\\n' "$$" > ${shellQuote(innerPidPath)}`,
    `stty cols ${scenario.columns} rows ${scenario.rows}`,
    `exec ${[fixture.piExecutablePath, ...piArguments].map(shellQuote).join(" ")}`,
  ].join(" && ");
  const session = createPtySession(shellCommand, {
    cwd: scenarioRoot,
    innerPidPath,
    env: {
      ...process.env,
      COLORTERM: "truecolor",
      HOME: homeDirectory,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PI_CODING_AGENT_DIR: agentDirectory,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      SHELL: "/bin/bash",
      TERM: "xterm-256color",
    },
  });

  const checkpoints = createScenarioCheckpoints(scenario);
  const extensionLogPath = path.join(agentDirectory, "pi-tokyo-night.log");
  let extensionLog = "";

  try {
    for (const checkpoint of checkpoints.slice(0, 2)) {
      await waitForText(
        session,
        checkpoint,
        FIRST_FRAME_TIMEOUT_MS,
        `${scenario.name} first frame`,
      );
    }
    writeInput(session, "/tokyo-night\r", `${scenario.name} command`);
    for (const checkpoint of checkpoints.slice(2)) {
      await waitForText(
        session,
        checkpoint,
        STUDIO_TIMEOUT_MS,
        `${scenario.name} Neon Studio`,
      );
    }
    writeInput(session, "\x1b", `${scenario.name} Escape`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    writeInput(session, "/quit\r", `${scenario.name} quit`);
    await waitForExit(session, EXIT_TIMEOUT_MS, scenario.name);

    extensionLog = await readOptionalFile(extensionLogPath);
    assertOutputWithinLimit(session.overflow, scenario.name);
    assertOrderedCheckpoints(session.output, checkpoints);
    assertNoFatalOutput(session.output, extensionLog);
    console.log(
      `Pi TUI smoke ${scenario.name} passed (${scenario.columns}x${scenario.rows})`,
    );
  } catch (error) {
    await stopPtySession(session);
    extensionLog ||= await readOptionalFile(extensionLogPath);
    console.error(
      `\n${scenario.name} captured output:\n${outputTail(session.output)}`,
    );
    if (extensionLog) {
      console.error(
        `\n${scenario.name} extension log:\n${outputTail(extensionLog)}`,
      );
    }
    throw error;
  }
}

export async function main() {
  if (process.platform !== "linux") {
    throw new Error("Pi TUI smoke requires Linux and util-linux script");
  }

  const piVersion = await resolvePiVersion();
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "pi-tokyo-night-smoke-"),
  );
  try {
    const fixture = await installPackedFixture(temporaryRoot, piVersion);
    console.log(
      `Installed ${path.basename(fixture.installedPackageRoot)} tarball with Pi ${piVersion}`,
    );
    for (const scenario of SMOKE_SCENARIOS) {
      await runScenario(fixture, temporaryRoot, scenario);
    }
    console.log(
      `Pi ${piVersion} tarball TUI smoke completed (${SMOKE_SCENARIOS.length} scenarios)`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
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
