import { spawnSync } from "node:child_process";
import path from "node:path";

function assertSmokeResult(result) {
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") return;
    throw result.error;
  }

  if (result.status !== 0) {
    const detail = result.signal
      ? `signal ${result.signal}`
      : `code ${result.status ?? "unknown"}`;
    throw new Error(`Pi TUI smoke exited with ${detail}`);
  }
}

const extension = path.resolve("extensions/pi-tokyo-night");
const command = `npx --no-install pi --offline --no-session --no-extensions --extension ${JSON.stringify(extension)}`;
const result = spawnSync("script", ["-qec", command, "/dev/null"], {
  input: "/tokyo-night\n\u001b",
  encoding: "utf8",
  timeout: 15_000,
  maxBuffer: 4 * 1024 * 1024,
});
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

const expectedTimeout = result.error?.code === "ETIMEDOUT";
if (!expectedTimeout && (result.error || result.status !== 0)) console.error(output);
assertSmokeResult(result);

for (const forbidden of ["uncaughtException", "Maximum call stack size exceeded"]) {
  if (output.includes(forbidden)) {
    console.error(output);
    throw new Error(`Pi TUI smoke output contains ${forbidden}`);
  }
}
console.log(`Pi ${process.env.PI_COMPAT_VERSION ?? "unknown"} TUI smoke completed`);
