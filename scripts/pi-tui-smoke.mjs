import { spawnSync } from "node:child_process";
import path from "node:path";

const extension = path.resolve("extensions/pi-tokyo-night");
const command = `npx --no-install pi --offline --no-session --no-extensions --extension ${JSON.stringify(extension)}`;
const result = spawnSync("script", ["-qec", command, "/dev/null"], {
  input: "/tokyo-night\n\u001b",
  encoding: "utf8",
  timeout: 15_000,
  maxBuffer: 4 * 1024 * 1024,
});
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

for (const forbidden of ["uncaughtException", "Maximum call stack size exceeded"]) {
  if (output.includes(forbidden)) {
    console.error(output);
    throw new Error(`Pi TUI smoke output contains ${forbidden}`);
  }
}
if (result.error && result.error.code !== "ETIMEDOUT") throw result.error;
console.log(`Pi ${process.env.PI_COMPAT_VERSION ?? "unknown"} TUI smoke completed`);
