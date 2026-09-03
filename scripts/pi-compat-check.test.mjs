import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PI_CORE_PACKAGES,
  createCompatibilityManifest,
  createRuntimeInstallCommand,
} from "./pi-compat-check.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("Pi compatibility fixture", () => {
  it("installs one aligned Pi version without the project peer graph", () => {
    expect(createCompatibilityManifest("0.82.0")).toEqual({
      private: true,
      dependencies: Object.fromEntries(
        PI_CORE_PACKAGES.map((packageName) => [packageName, "0.82.0"]),
      ),
    });
  });

  it("roots dependency installation in the isolated runtime", () => {
    const runtimeRoot = path.join(projectRoot, ".pi-compat-test");
    const command = createRuntimeInstallCommand(runtimeRoot, "linux");

    expect(command.cwd).toBe(runtimeRoot);
    expect(command.cwd).not.toBe(projectRoot);
    expect(command.command).toBe("npm");
    expect(createRuntimeInstallCommand(runtimeRoot, "win32").command).toBe(
      "npm.cmd",
    );
    expect(command.args).toContain("--package-lock=false");
    expect(command.args).not.toContain("--legacy-peer-deps");
  });

  it("routes compatibility workflows through the isolated checker", () => {
    const workflowPaths = [
      ".github/workflows/compatibility.yml",
      ".github/workflows/publish.yml",
    ];

    for (const workflowPath of workflowPaths) {
      const workflow = readFileSync(
        path.join(projectRoot, workflowPath),
        "utf8",
      );
      expect(workflow).toContain("node scripts/pi-compat-check.mjs");
      expect(workflow).not.toMatch(
        /npm install [^\n]*@earendil-works\/pi-ai@/,
      );
      expect(workflow).not.toContain("--legacy-peer-deps");
    }

    const manifest = JSON.parse(
      readFileSync(path.join(projectRoot, "package.json"), "utf8"),
    );
    expect(manifest.scripts.compatibility).toBe(
      "node scripts/pi-compat-check.mjs",
    );
  });
});
