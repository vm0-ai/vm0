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
  });
});
