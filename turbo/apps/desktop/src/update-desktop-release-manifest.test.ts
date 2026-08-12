import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const scriptPath = join(
  __dirname,
  "..",
  "scripts",
  "update-desktop-release-manifest.mjs",
);

function temporaryManifestPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "desktop-manifest-"));
  temporaryDirectories.push(directory);
  return join(directory, "manifest.json");
}

function runManifestUpdate(
  manifestPath: string,
  product: "zero" | "okou",
  zipAssetName: string,
): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      scriptPath,
      "--manifest",
      manifestPath,
      "--product",
      product,
      "--version",
      "1.2.3",
      "--zip-url",
      `https://github.com/vm0-ai/vm0/releases/download/test/${zipAssetName}`,
      "--pub-date",
      "2026-08-11T00:00:00.000Z",
    ],
    { encoding: "utf8" },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("update desktop release manifest", () => {
  it.each([
    {
      product: "zero" as const,
      artifactName: "Zero-darwin-arm64-1.2.3.zip",
      releaseName: "Zero Computer Use 1.2.3",
    },
    {
      product: "okou" as const,
      artifactName: "Okou-darwin-arm64-1.2.3.zip",
      releaseName: "Okou Computer Use 1.2.3",
    },
  ])("publishes an isolated $product manifest", (testCase) => {
    const manifestPath = temporaryManifestPath();
    const result = runManifestUpdate(
      manifestPath,
      testCase.product,
      testCase.artifactName,
    );

    expect(result.status, result.stderr).toBe(0);
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      product: testCase.product,
      channels: { stable: { latest: "1.2.3", blocked: [] } },
      releases: {
        "1.2.3": {
          version: "1.2.3",
          name: testCase.releaseName,
          platforms: {
            darwin: {
              arm64: {
                url: `https://github.com/vm0-ai/vm0/releases/download/test/${testCase.artifactName}`,
              },
            },
          },
        },
      },
    });
  });

  it("rejects a Zero artifact when publishing an Okou manifest", () => {
    const result = runManifestUpdate(
      temporaryManifestPath(),
      "okou",
      "Zero-darwin-arm64-1.2.3.zip",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Desktop update asset must be Okou-darwin-arm64-1.2.3.zip",
    );
  });
});
