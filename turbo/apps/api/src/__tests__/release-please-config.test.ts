import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type PackageJson = {
  dependencies?: Record<string, string>;
};

type VersionedPackageJson = {
  version: string;
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
      return name.startsWith("@okouai/") && specifier === "workspace:*";
    })
    .map(([name]) => {
      return `turbo/packages/${name.replace("@okouai/", "")}`;
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

  it("keeps CLI build identity release-managed", () => {
    const releaseConfig = readJson<ReleasePleaseConfig>(
      "release-please-config.json",
    );
    const manifest = readJson<Record<string, string>>(
      ".release-please-manifest.json",
    );
    const cliPackage = readJson<VersionedPackageJson>(
      "turbo/apps/cli/package.json",
    );

    expect(releaseConfig.packages["turbo/apps/cli"]).toStrictEqual({
      "release-type": "node",
      component: "cli",
    });
    expect(manifest["turbo/apps/cli"]).toBe(cliPackage.version);
  });

  it("keeps connector catalog validator identity release-managed", () => {
    const releaseConfig = readJson<ReleasePleaseConfig>(
      "release-please-config.json",
    );
    const manifest = readJson<Record<string, string>>(
      ".release-please-manifest.json",
    );
    const validatorPackage = readJson<VersionedPackageJson>(
      "turbo/packages/connector-catalog-validation/package.json",
    );

    expect(
      releaseConfig.packages["turbo/packages/connector-catalog-validation"],
    ).toStrictEqual({
      "release-type": "node",
      "skip-changelog": true,
    });
    expect(manifest["turbo/packages/connector-catalog-validation"]).toBe(
      validatorPackage.version,
    );
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

  it("builds and deploys API for every release", () => {
    const workflow = readText(".github/workflows/release-please.yml");
    const promoteApiProductionJob = workflowJobBlock(
      workflow,
      "promote-api-production",
    );
    const promoteApiProductionHeader = promoteApiProductionJob.slice(
      0,
      promoteApiProductionJob.indexOf("    steps:\n"),
    );

    expect(promoteApiProductionHeader).toContain(
      "needs: [release-please, builds-complete]",
    );
    expect(promoteApiProductionJob).toContain("always() &&");
    expect(promoteApiProductionJob).toContain(
      "needs.release-please.outputs.releases_created == 'true'",
    );
    expect(promoteApiProductionJob).not.toContain("api_deploy_required");
    expect(promoteApiProductionHeader).not.toContain("api_release_created");

    const deployApiSchemaJob = workflowJobBlock(workflow, "deploy-api-schema");
    expect(deployApiSchemaJob).toContain(
      "needs: [release-please, promote-api-production]",
    );
  });

  it("builds the API before migrations and deploys it afterward", () => {
    const workflow = readText(".github/workflows/release-please.yml");
    const promoteApiProductionJob = workflowJobBlock(
      workflow,
      "promote-api-production",
    );
    const buildStep = promoteApiProductionJob.indexOf(
      "- name: Build API Production Artifact",
    );
    const productionEnvironmentStep = promoteApiProductionJob.indexOf(
      "- name: Resolve API production environment",
    );
    const schemaUploadStep = promoteApiProductionJob.indexOf(
      "- name: Upload Runtime API Schema Artifact",
    );
    const buildStepEnd = promoteApiProductionJob.indexOf(
      "- name: Install neonctl",
    );
    const migrationSmokeStep = promoteApiProductionJob.indexOf(
      "- name: Run Production Migration Smoke Test",
    );
    const migrationStep = promoteApiProductionJob.indexOf(
      "- name: Run Production Migrations",
    );
    const deploymentToolchainStep = promoteApiProductionJob.indexOf(
      "- name: Initialize API deployment toolchain",
    );
    const deploymentStep = promoteApiProductionJob.indexOf(
      "- name: Deploy API Production",
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
    expect(
      promoteApiProductionJob.match(/\.\/\.github\/actions\/vercel-deploy/g),
    ).toHaveLength(1);
    expect(
      promoteApiProductionJob.match(/pnpm --dir turbo\/apps\/api build/g),
    ).toHaveLength(1);
    expect(schemaUploadStep).toBeGreaterThan(-1);
    expect(buildStep).toBeGreaterThan(-1);
    expect(buildStep).toBeGreaterThan(schemaUploadStep);
    expect(
      promoteApiProductionJob.slice(schemaUploadStep, buildStep),
    ).toContain("overwrite: true");
    expect(buildStepEnd).toBeGreaterThan(buildStep);
    expect(
      promoteApiProductionJob.slice(buildStep, buildStepEnd),
    ).not.toContain("secrets.");
    expect(deploymentToolchainStep).toBeGreaterThan(-1);
    expect(productionEnvironmentStep).toBeGreaterThan(buildStep);
    expect(deploymentToolchainStep).toBeGreaterThan(buildStep);
    expect(migrationSmokeStep).toBeGreaterThan(buildStep);
    expect(migrationStep).toBeGreaterThan(-1);
    expect(migrationStep).toBeGreaterThan(deploymentToolchainStep);
    expect(migrationStep).toBeGreaterThan(migrationSmokeStep);
    expect(deploymentStep).toBeGreaterThan(migrationStep);
    expect(promoteApiProductionJob).toContain('prebuilt: "true"');
    expect(promoteApiProductionJob).toContain('skip-setup: "true"');
  });

  it("stages and validates the API before production promotion", () => {
    const workflow = readText(".github/workflows/release-please.yml");
    const promoteApiProductionJob = workflowJobBlock(
      workflow,
      "promote-api-production",
    );
    const deployStep = promoteApiProductionJob.indexOf(
      "- name: Deploy API Production",
    );
    const healthStep = promoteApiProductionJob.indexOf(
      "- name: Check staged API health",
    );
    const reconcileStep = promoteApiProductionJob.indexOf(
      "- name: Reconcile staged connector catalog",
    );
    const promoteStep = promoteApiProductionJob.indexOf(
      "- name: Promote API Production",
    );
    const verifyDomainsStep = promoteApiProductionJob.indexOf(
      "- name: Verify production App and API domains",
    );

    expect(deployStep).toBeGreaterThan(-1);
    expect(healthStep).toBeGreaterThan(deployStep);
    expect(reconcileStep).toBeGreaterThan(healthStep);
    expect(promoteStep).toBeGreaterThan(reconcileStep);
    expect(verifyDomainsStep).toBeGreaterThan(promoteStep);

    const deployBlock = promoteApiProductionJob.slice(deployStep, healthStep);
    expect(deployBlock).toContain('skip-domain: "true"');

    const healthBlock = promoteApiProductionJob.slice(
      healthStep,
      reconcileStep,
    );
    expect(healthBlock).toContain(
      `API_DEPLOYMENT_URL: \${{ steps.deploy.outputs.url }}`,
    );
    expect(healthBlock).toContain(
      'vercel curl /health --deployment "$API_DEPLOYMENT_URL"',
    );

    const reconcileBlock = promoteApiProductionJob.slice(
      reconcileStep,
      promoteStep,
    );
    expect(reconcileBlock).toContain(
      `API_DEPLOYMENT_URL: \${{ steps.deploy.outputs.url }}`,
    );
    expect(reconcileBlock).toContain(
      "vercel curl /api/cron/sync-connector-catalog",
    );
    expect(reconcileBlock).toContain(
      `--header "Authorization: Bearer \${CRON_SECRET}"`,
    );
    expect(reconcileBlock).toContain("hasActive: (.active != null)");
    expect(reconcileBlock).toContain(
      "lastAttemptOutcome: .lastAttempt.outcome",
    );
    expect(reconcileBlock).not.toContain("capabilityDigest:");
    expect(reconcileBlock).toContain('.state == "current"');
    expect(reconcileBlock).toContain(".active != null");
    expect(reconcileBlock).toContain(".filtering.stale == false");

    const promoteBlock = promoteApiProductionJob.slice(
      promoteStep,
      verifyDomainsStep,
    );
    expect(promoteBlock).toContain("uses: ./.github/actions/vercel-promote");
    expect(promoteBlock).toContain(
      `deployment-url: \${{ steps.deploy.outputs.url }}`,
    );
    expect(promoteBlock).toContain('skip-setup: "true"');
  });

  it("keeps Vercel setup enabled for other deployment callers", () => {
    const action = readText(".github/actions/vercel-deploy/action.yml");
    const skipSetupInputStart = action.indexOf("  skip-setup:\n");
    const runsStart = action.indexOf("\nruns:\n");

    expect(skipSetupInputStart).toBeGreaterThan(-1);
    expect(runsStart).toBeGreaterThan(skipSetupInputStart);
    expect(action.slice(skipSetupInputStart, runsStart)).toContain(
      'default: "false"',
    );
    expect(action).toContain(`if: \${{ inputs.skip-setup != 'true' }}`);
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
