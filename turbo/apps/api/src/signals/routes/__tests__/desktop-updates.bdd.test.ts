import { desktopUpdatesContract } from "@vm0/api-contracts/contracts/desktop-updates";
import { beforeEach, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  clearDesktopUpdateManifestCacheForTest,
  mockDesktopUpdateManifestForTest,
  type DesktopUpdateManifest,
} from "../../services/desktop-updates.service";

// BDD migration of the legacy `desktop-updates.test.ts`. The Given
// uses a test-only manifest helper (a tiny in-process mock, not a DB
// write). Each scenario is one Given → When → Then step; the legacy
// 3 `it()`s collapse into a single GWT-WT-WT chain sharing the route
// shape but switching the manifest between steps.

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
    name: `Zero Computer Use ${version}`,
    notes: `Release ${version}`,
    pubDate: "2026-06-08T00:00:00.000Z",
    platforms: {
      darwin: {
        arm64: { url },
      },
    },
  };
}

describe("BDD desktop update routes", () => {
  beforeEach(() => {
    clearDesktopUpdateManifestCacheForTest();
  });

  it("gwt-wt-wt: serves current release → blocks bad release → 404 on missing asset", async () => {
    const c = client();

    // Given: a stable manifest whose latest release is 0.2.1 with a
    // darwin/arm64 asset.
    const zipUrl =
      "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.2.1/Zero-darwin-arm64-0.2.1.zip";
    mockDesktopUpdateManifestForTest(
      stableManifest("0.2.1", {
        "0.2.1": darwinArm64Release("0.2.1", zipUrl),
      }),
    );

    // When + Then: the route returns the current release as the
    // `currentRelease` and the matching asset under `releases`.
    const current = await accept(
      c.feed({
        params: { channel: "stable", platform: "darwin", arch: "arm64" },
      }),
      [200],
    );
    expect(current.body).toStrictEqual({
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

    // Given: a fresh manifest whose 0.2.2 release is blocked.
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

    // When + Then: the route skips 0.2.2 (blocked) and reports 0.2.1
    // as the current release.
    const blocked = await accept(
      c.feed({
        params: { channel: "stable", platform: "darwin", arch: "arm64" },
      }),
      [200],
    );
    expect(blocked.body.currentRelease).toBe("0.2.1");
    expect(blocked.body.releases[0]?.updateTo.url).toBe(previousUrl);

    // Given: a manifest where the latest version exists but has no
    // darwin/arm64 asset.
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

    // When + Then: the route returns 404.
    const missing = await accept(
      c.feed({
        params: { channel: "stable", platform: "darwin", arch: "arm64" },
      }),
      [404],
    );
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });
});
