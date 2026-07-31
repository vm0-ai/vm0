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

  it("builds and promotes API for every release", () => {
    const workflow = readText(".github/workflows/release-please.yml");
    const apiBuildJob = workflowJobBlock(workflow, "build-api-production");

    expect(apiBuildJob).toContain(
      `if: \${{ needs.release-please.outputs.releases_created == 'true' }}`,
    );
    expect(apiBuildJob).not.toContain("api_deploy_required");

    const promoteApiProductionJob = workflowJobBlock(
      workflow,
      "promote-api-production",
    );
    const promoteApiProductionHeader = promoteApiProductionJob.slice(
      0,
      promoteApiProductionJob.indexOf("    steps:\n"),
    );

    expect(workflow).not.toContain("\n  migrate-production:\n");
    expect(promoteApiProductionJob).toContain("always() &&");
    expect(promoteApiProductionJob).toContain(
      "needs.release-please.outputs.releases_created == 'true'",
    );
    expect(promoteApiProductionJob).not.toContain("api_deploy_required");
    expect(promoteApiProductionHeader).not.toContain("api_release_created");
  });

  it("prepares API promotion before release migrations", () => {
    const workflow = readText(".github/workflows/release-please.yml");
    const promoteApiProductionJob = workflowJobBlock(
      workflow,
      "promote-api-production",
    );
    const migrationStep = promoteApiProductionJob.indexOf(
      "- name: Run Production Migrations",
    );
    const deploymentToolchainStep = promoteApiProductionJob.indexOf(
      "- name: Initialize API deployment toolchain",
    );
    const promotionStep = promoteApiProductionJob.indexOf(
      "- name: Promote API Deployment",
    );

    expect(promoteApiProductionJob).toContain(
      "needs.release-please.outputs.api_release_created == 'true'",
    );
    expect(
      promoteApiProductionJob.match(/\.\/\.github\/actions\/toolchain-init/g),
    ).toHaveLength(1);
    expect(
      promoteApiProductionJob.match(/\.\/\.github\/actions\/vercel-setup/g),
    ).toHaveLength(1);
    expect(deploymentToolchainStep).toBeGreaterThan(-1);
    expect(migrationStep).toBeGreaterThan(-1);
    expect(migrationStep).toBeGreaterThan(deploymentToolchainStep);
    expect(promotionStep).toBeGreaterThan(migrationStep);
    expect(promoteApiProductionJob).toContain('skip-setup: "true"');
  });

  it("keeps Vercel setup enabled for other promotion callers", () => {
    const action = readText(".github/actions/vercel-promote/action.yml");
    const skipSetupInputStart = action.indexOf("  skip-setup:\n");
    const outputsStart = action.indexOf("\noutputs:\n");

    expect(skipSetupInputStart).toBeGreaterThan(-1);
    expect(outputsStart).toBeGreaterThan(skipSetupInputStart);
    expect(action.slice(skipSetupInputStart, outputsStart)).toContain(
      'default: "false"',
    );
    expect(action).toContain(`if: \${{ inputs.skip-setup != 'true' }}`);
  });

  it("promotes App after the API production lifecycle", () => {
    const workflow = readText(".github/workflows/release-please.yml");
    const promoteAppProductionJob = workflowJobBlock(
      workflow,
      "promote-app-production",
    );

    expect(promoteAppProductionJob).toContain(
      "needs: [release-please, builds-complete, promote-api-production]",
    );
    expect(promoteAppProductionJob).toContain(
      "needs.promote-api-production.result == 'success'",
    );
  });
});
