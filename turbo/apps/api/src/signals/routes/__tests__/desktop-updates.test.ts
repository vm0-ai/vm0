import { desktopUpdatesContract } from "@vm0/api-contracts/contracts/desktop-updates";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  clearDesktopUpdateManifestCacheForTest,
  mockDesktopUpdateManifestForTest,
  type DesktopUpdateManifest,
} from "../../services/desktop-updates.service";

const context = testContext();

function client() {
  return setupApp({ context })(desktopUpdatesContract);
}

function stableManifest(
  latest: string,
  releases: DesktopUpdateManifest["releases"],
  blocked: readonly string[] = [],
): DesktopUpdateManifest {
  return {
    schemaVersion: 1,
    channels: {
      stable: { latest, blocked: [...blocked] },
    },
    releases,
  };
}

function darwinArm64Release(version: string, url: string) {
  return {
    version,
    name: `Zero ${version}`,
    notes: `Release ${version}`,
    pubDate: "2026-06-08T00:00:00.000Z",
    platforms: {
      darwin: {
        arm64: { url },
      },
    },
  };
}

describe("desktop update routes", () => {
  beforeEach(() => {
    clearDesktopUpdateManifestCacheForTest();
  });

  it("serves the current stable macOS arm64 update from the manifest", async () => {
    const zipUrl =
      "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.2.1/Zero-darwin-arm64-0.2.1.zip";
    mockDesktopUpdateManifestForTest(
      stableManifest("0.2.1", {
        "0.2.1": darwinArm64Release("0.2.1", zipUrl),
      }),
    );

    const response = await accept(
      client().feed({
        params: { channel: "stable", platform: "darwin", arch: "arm64" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      currentRelease: "0.2.1",
      releases: [
        {
          version: "0.2.1",
          updateTo: {
            name: "Zero 0.2.1",
            version: "0.2.1",
            pub_date: "2026-06-08T00:00:00.000Z",
            url: zipUrl,
            notes: "Release 0.2.1",
          },
        },
      ],
    });
  });

  it("does not return a blocked latest release", async () => {
    const previousUrl =
      "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.2.1/Zero-darwin-arm64-0.2.1.zip";
    mockDesktopUpdateManifestForTest(
      stableManifest(
        "0.2.2",
        {
          "0.2.1": darwinArm64Release("0.2.1", previousUrl),
          "0.2.2": darwinArm64Release(
            "0.2.2",
            "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.2.2/Zero-darwin-arm64-0.2.2.zip",
          ),
          "0.3.0": darwinArm64Release(
            "0.3.0",
            "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.3.0/Zero-darwin-arm64-0.3.0.zip",
          ),
        },
        ["0.2.2"],
      ),
    );

    const response = await accept(
      client().feed({
        params: { channel: "stable", platform: "darwin", arch: "arm64" },
      }),
      [200],
    );

    expect(response.body.currentRelease).toBe("0.2.1");
    expect(response.body.releases[0]?.updateTo.url).toBe(previousUrl);
  });

  it("returns not found when the manifest has no matching asset", async () => {
    mockDesktopUpdateManifestForTest(
      stableManifest("0.2.1", {
        "0.2.1": {
          version: "0.2.1",
          pubDate: "2026-06-08T00:00:00.000Z",
          platforms: {
            darwin: {},
          },
        },
      }),
    );

    const response = await accept(
      client().feed({
        params: { channel: "stable", platform: "darwin", arch: "arm64" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
