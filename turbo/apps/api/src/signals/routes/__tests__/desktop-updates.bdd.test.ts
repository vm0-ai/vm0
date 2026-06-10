import { accept, testContext } from "../../../__tests__/test-helpers";
import {
  clearDesktopUpdateManifestCacheForTest,
  mockDesktopUpdateManifestForTest,
  type DesktopUpdateManifest,
} from "../../services/desktop-updates.service";
import { createBddApi } from "./helpers/api-bdd";

// API-first BDD coverage for the public desktop auto-update feed. The release
// manifest is fetched from GitHub, an external dependency, so it is injected
// through the service's manifest test seam (it overrides the remote content,
// not any internal logic). Everything else is a real HTTP request. See
// `api.bdd.md` (CHAIN-DESKTOP-UPDATES).
const context = testContext();

function stableManifest(
  latest: string,
  releases: DesktopUpdateManifest["releases"],
  blocked: readonly string[] = [],
): DesktopUpdateManifest {
  return {
    schemaVersion: 1,
    channels: { stable: { latest, blocked: [...blocked] } },
    releases,
  };
}

function darwinArm64Release(version: string, url: string) {
  return {
    version,
    name: `Zero Computer Use ${version}`,
    notes: `Release ${version}`,
    pubDate: "2026-06-08T00:00:00.000Z",
    platforms: { darwin: { arm64: { url } } },
  };
}

const DARWIN_ARM64 = {
  channel: "stable",
  platform: "darwin",
  arch: "arm64",
} as const;

describe("desktop update feed (API-first BDD)", () => {
  it("serves the current stable macOS arm64 release from the manifest", async () => {
    const api = createBddApi(context);
    clearDesktopUpdateManifestCacheForTest();
    const zipUrl =
      "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.2.1/Zero-darwin-arm64-0.2.1.zip";
    mockDesktopUpdateManifestForTest(
      stableManifest("0.2.1", {
        "0.2.1": darwinArm64Release("0.2.1", zipUrl),
      }),
    );

    const response = await accept(
      api.desktopUpdates.feed({ params: DARWIN_ARM64 }),
      [200],
    );

    expect(response.body).toStrictEqual({
      currentRelease: "0.2.1",
      releases: [
        {
          version: "0.2.1",
          updateTo: {
            name: "Zero Computer Use 0.2.1",
            version: "0.2.1",
            pub_date: "2026-06-08T00:00:00.000Z",
            url: zipUrl,
            notes: "Release 0.2.1",
          },
        },
      ],
    });
  });

  it("falls back past a blocked latest release", async () => {
    const api = createBddApi(context);
    clearDesktopUpdateManifestCacheForTest();
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
      api.desktopUpdates.feed({ params: DARWIN_ARM64 }),
      [200],
    );

    // The blocked 0.2.2 is skipped and the newer 0.3.0 is above `latest`, so the
    // previous 0.2.1 is served.
    expect(response.body.currentRelease).toBe("0.2.1");
    expect(response.body.releases[0]?.updateTo.url).toBe(previousUrl);
  });

  it("returns not found when no matching asset exists", async () => {
    const api = createBddApi(context);
    clearDesktopUpdateManifestCacheForTest();
    mockDesktopUpdateManifestForTest(
      stableManifest("0.2.1", {
        "0.2.1": {
          version: "0.2.1",
          pubDate: "2026-06-08T00:00:00.000Z",
          platforms: { darwin: {} },
        },
      }),
    );

    const response = await accept(
      api.desktopUpdates.feed({ params: DARWIN_ARM64 }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
