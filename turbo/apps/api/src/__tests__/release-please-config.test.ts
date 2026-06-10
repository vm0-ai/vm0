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
    const apiPackage = readJson<PackageJson>("turbo/apps/api/package.json");
    const releaseConfig = readJson<ReleasePleaseConfig>(
      "release-please-config.json",
    );
    const manifest = readJson<Record<string, string>>(
      ".release-please-manifest.json",
    );

    const workspaceDependencyPaths = Object.entries(
      apiPackage.dependencies ?? {},
    )
      .filter(([name, specifier]) => {
        return name.startsWith("@vm0/") && specifier === "workspace:*";
      })
      .map(([name]) => {
        return `turbo/packages/${name.replace("@vm0/", "")}`;
      });

    for (const packagePath of workspaceDependencyPaths) {
      expect(releaseConfig.packages).toHaveProperty(packagePath);
      expect(manifest).toHaveProperty(packagePath);
    }
  });
});
