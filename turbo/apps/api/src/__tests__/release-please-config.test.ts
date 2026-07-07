import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type PackageJson = {
  dependencies?: Record<string, string>;
};

type ReleasePleaseConfig = {
  packages: Record<string, unknown>;
};

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, path), "utf8")) as T;
}

function readText(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function apiRuntimeWorkspaceDependencyPaths(): string[] {
  const apiPackage = readJson<PackageJson>("turbo/apps/api/package.json");

  return Object.entries(apiPackage.dependencies ?? {})
    .filter(([name, specifier]) => {
      return name.startsWith("@vm0/") && specifier === "workspace:*";
    })
    .map(([name]) => {
      return `turbo/packages/${name.replace("@vm0/", "")}`;
    });
}

function workflowJobBlock(workflow: string, jobName: string): string {
  const jobStart = workflow.indexOf(`  ${jobName}:\n`);
  if (jobStart === -1) {
    throw new Error(`Missing workflow job: ${jobName}`);
  }

  const afterJobStart = workflow.slice(jobStart + `  ${jobName}:\n`.length);
  const nextJobOffset = afterJobStart.search(/\n {2}[a-zA-Z0-9_-]+:\n/);

  if (nextJobOffset === -1) {
    return workflow.slice(jobStart);
  }

  return workflow.slice(
    jobStart,
    jobStart + `  ${jobName}:\n`.length + nextJobOffset,
  );
}

describe("release-please API deployment graph", () => {
  it("keeps every release package in the manifest", () => {
    const releaseConfig = readJson<ReleasePleaseConfig>(
      "release-please-config.json",
    );
    const manifest = readJson<Record<string, string>>(
      ".release-please-manifest.json",
    );

    for (const packagePath of Object.keys(releaseConfig.packages)) {
      expect(manifest).toHaveProperty(packagePath);
    }
  });

  it("tracks every API runtime workspace dependency", () => {
    const releaseConfig = readJson<ReleasePleaseConfig>(
      "release-please-config.json",
    );
    const manifest = readJson<Record<string, string>>(
      ".release-please-manifest.json",
    );

    for (const packagePath of apiRuntimeWorkspaceDependencyPaths()) {
      expect(releaseConfig.packages).toHaveProperty(packagePath);
      expect(manifest).toHaveProperty(packagePath);
    }
  });

  it("deploys API when runtime workspace dependencies release", () => {
    const workflow = readText(".github/workflows/release-please.yml");
    const apiDeployRequiredLine =
      workflow.split("\n").find((line) => {
        return line.includes("api_deploy_required:");
      }) ?? "";

    expect(apiDeployRequiredLine).toContain("turbo/apps/api--release_created");

    const dbReleaseIsHandledByMigrationCoupling = new Set([
      "turbo/packages/db",
    ]);
    const deployDependencyPaths = apiRuntimeWorkspaceDependencyPaths().filter(
      (packagePath) => {
        return !dbReleaseIsHandledByMigrationCoupling.has(packagePath);
      },
    );

    for (const packagePath of deployDependencyPaths) {
      expect(apiDeployRequiredLine).toContain(
        `${packagePath}--release_created`,
      );
    }

    expect(workflow).toContain(
      "if: $" +
        "{{ needs.release-please.outputs.api_deploy_required == 'true' }}",
    );

    const promoteApiProductionJob = workflowJobBlock(
      workflow,
      "promote-api-production",
    );

    expect(promoteApiProductionJob).toContain("migrate-production");
    expect(promoteApiProductionJob).toContain("always() &&");
    expect(promoteApiProductionJob).toContain(
      "needs.release-please.outputs.api_deploy_required == 'true'",
    );
    expect(promoteApiProductionJob).toContain(
      "needs.release-please.outputs.api_release_created != 'true'",
    );
    expect(promoteApiProductionJob).toContain(
      "needs.migrate-production.result == 'success'",
    );
  });

  it("blocks app promotion when API runtime paths have unreleased diffs", () => {
    const workflow = readText(".github/workflows/release-please.yml");
    const consistencyJob = workflowJobBlock(
      workflow,
      "verify-release-deploy-consistency",
    );
    const buildsCompleteJob = workflowJobBlock(workflow, "builds-complete");
    const migrateProductionJob = workflowJobBlock(
      workflow,
      "migrate-production",
    );
    const promoteAppProductionJob = workflowJobBlock(
      workflow,
      "promote-app-production",
    );

    expect(consistencyJob).toContain("app_release_created == 'true'");
    expect(consistencyJob).toContain("tag_commit");
    expect(consistencyJob).toContain("instead of release head $head_commit");
    expect(consistencyJob).toContain("git diff --quiet");
    expect(consistencyJob).toContain(
      "release-please did not create a ${tag_prefix} release",
    );
    expect(consistencyJob).toContain("turbo/apps/platform");
    expect(consistencyJob).toContain("turbo/apps/api");

    for (const packagePath of apiRuntimeWorkspaceDependencyPaths()) {
      expect(consistencyJob).toContain(packagePath);
    }

    expect(buildsCompleteJob).toContain("verify-release-deploy-consistency");
    expect(migrateProductionJob).toContain(
      "needs.builds-complete.result == 'success'",
    );
    expect(promoteAppProductionJob).toContain(
      "needs.builds-complete.result == 'success'",
    );
  });

  it("pins production app and API builds to the triggering main commit", () => {
    const workflow = readText(".github/workflows/release-please.yml");
    const apiBuildJob = workflowJobBlock(workflow, "build-api-production");
    const appBuildJob = workflowJobBlock(workflow, "build-app-production");
    const releaseHeadRef =
      "ref: ${{ github.event.workflow_run.head_sha || github.sha }}";

    expect(apiBuildJob).toContain(releaseHeadRef);
    expect(appBuildJob).toContain(releaseHeadRef);
  });
});
