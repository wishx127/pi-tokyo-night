import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readWorkflow(name) {
  return parse(readFileSync(
    path.join(projectRoot, ".github", "workflows", name),
    "utf8",
  ));
}

describe("CI validation and publication", () => {
  it("validates release tags once and requires successful validation before publishing", () => {
    const compatibility = readWorkflow("compatibility.yml");
    const publish = readWorkflow("publish.yml");

    expect(compatibility.on.push).toMatchObject({
      branches: ["**"],
      "tags-ignore": ["v*"],
    });
    expect(publish.on.push.tags).toEqual(["v*"]);

    const checks = Object.entries(publish.jobs).filter(([, job]) => job.uses);
    expect(checks).toHaveLength(1);
    const [checkId, checkJob] = checks[0];
    expect(checkJob.uses).toBe("./.github/workflows/pi-checks.yml");
    expect(Object.values(compatibility.jobs).map((job) => job.uses)).toEqual([
      checkJob.uses,
    ]);

    const publisher = Object.values(publish.jobs).find((job) =>
      job.steps?.some((step) => step.run?.includes("npm publish"))
    );
    expect(publisher.needs).toEqual([checkId]);
    expect(publisher.if).toBeUndefined();
    expect(publisher["continue-on-error"]).toBeUndefined();
  });

  it("preserves scheduled, branch and PR checks with optional PR smoke", () => {
    const compatibility = readWorkflow("compatibility.yml");
    const publish = readWorkflow("publish.yml");
    const shared = readWorkflow("pi-checks.yml");

    expect(compatibility.on).toHaveProperty("pull_request");
    expect(compatibility.on.schedule).toEqual([{ cron: "0 6 * * 1" }]);
    expect(compatibility.jobs.checks.with.run_smoke).toBe(
      "${{ github.event_name != 'pull_request' }}",
    );
    expect(publish.jobs.checks.with).toEqual({
      run_smoke: true,
      fail_fast: true,
    });
    expect(shared.on.workflow_call.inputs).toEqual({
      run_smoke: { required: true, type: "boolean" },
      fail_fast: { type: "boolean", default: false },
    });
    expect(shared.jobs.smoke.if).toBe("${{ inputs.run_smoke }}");
  });

  it("keeps every compatibility version and packed smoke entry point", () => {
    const shared = readWorkflow("pi-checks.yml");
    const { matrix, smoke } = shared.jobs;

    expect(matrix.strategy.matrix.include).toEqual([
      { label: "minimum", version: "0.80.5" },
      { label: "historical", version: "0.82.0" },
      { label: "latest", version: "latest" },
    ]);
    expect(smoke.strategy.matrix.include).toEqual([
      { label: "minimum", version: "0.80.5" },
      { label: "latest", version: "latest" },
    ]);
    expect(matrix.steps.some((step) =>
      step.run?.startsWith("node scripts/pi-compat-check.mjs ")
    )).toBe(true);
    expect(smoke.steps.find((step) =>
      step.run === "node scripts/pi-tui-smoke.mjs"
    )?.env.PI_COMPAT_VERSION).toBe(
      "${{ steps.pi_version.outputs.version }}",
    );
    for (const job of [matrix, smoke]) {
      expect(job.strategy["fail-fast"]).toBe("${{ inputs.fail_fast }}");
      expect(job["continue-on-error"]).toBeUndefined();
    }
  });

  it("installs root dependencies only for the compatibility test tools", () => {
    const shared = readWorkflow("pi-checks.yml");
    const publish = readWorkflow("publish.yml");
    const hasRootInstall = (job) => job.steps.some((step) =>
      /\bnpm\s+(?:ci|install)\b/.test(step.run ?? "")
    );

    expect(hasRootInstall(shared.jobs.matrix)).toBe(true);
    expect(hasRootInstall(shared.jobs.smoke)).toBe(false);
    expect(hasRootInstall(publish.jobs.publish)).toBe(false);
    expect(shared.jobs.matrix.steps.some((step) =>
      step.run?.startsWith("npm pack")
    )).toBe(false);
  });

  it("keeps validation read-only and publication credentials confined to the publisher", () => {
    const shared = readWorkflow("pi-checks.yml");
    const compatibility = readWorkflow("compatibility.yml");
    const publish = readWorkflow("publish.yml");

    expect(shared.permissions).toEqual({ contents: "read" });
    expect(compatibility.permissions).toEqual({ contents: "read" });
    expect(publish.permissions).toEqual({ contents: "read" });
    expect(compatibility.jobs.checks.secrets).toBeUndefined();
    expect(publish.jobs.checks.secrets).toBeUndefined();
    expect(publish.jobs.publish.permissions).toEqual({
      "id-token": "write",
      contents: "read",
    });
    expect(publish.jobs.publish.steps.find((step) =>
      step.run === "npm publish --provenance --access public"
    )?.env).toEqual({ NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" });
    expect(publish.jobs.publish.steps.some((step) =>
      step.name === "Verify release metadata and Gallery media"
    )).toBe(true);
  });
});
