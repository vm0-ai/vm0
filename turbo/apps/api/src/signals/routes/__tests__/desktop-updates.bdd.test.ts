import { desktopUpdatesContract } from "@vm0/api-contracts/contracts/desktop-updates";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";

const context = testContext();
const DESKTOP_UPDATE_MANIFEST_URL =
  "https://github.com/vm0-ai/vm0/releases/download/desktop-updates/desktop-update-manifest.json";

interface DesktopUpdateAsset {
  readonly url: string;
}

interface DesktopUpdateRelease {
  readonly version: string;
  readonly name?: string;
  readonly notes?: string;
  readonly pubDate: string;
  readonly platforms: Record<string, Record<string, DesktopUpdateAsset>>;
}

interface DesktopUpdateManifest {
  readonly schemaVersion: 1;
  readonly channels: Record<
    string,
    { readonly latest: string; readonly blocked?: readonly string[] }
  >;
  readonly releases: Record<string, DesktopUpdateRelease>;
}

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
      stable: { latest, blocked },
    },
    releases,
  };
}

function darwinArm64Release(
  version: string,
  url: string,
): DesktopUpdateRelease {
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

function missingArm64Release(version: string): DesktopUpdateRelease {
  return {
    version,
    pubDate: "2026-06-08T00:00:00.000Z",
    platforms: {
      darwin: {},
    },
  };
}

describe("/api/desktop/updates BDD", () => {
  it("serves update feeds from the external manifest and handles fallback or missing assets", async () => {
    const zipUrl =
      "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.2.1/Zero-darwin-arm64-0.2.1.zip";
    let manifest = stableManifest("0.2.1", {
      "0.2.1": darwinArm64Release("0.2.1", zipUrl),
    });
    let manifestFetches = 0;
    server.use(
      http.get(DESKTOP_UPDATE_MANIFEST_URL, () => {
        manifestFetches += 1;
        return HttpResponse.json(manifest);
      }),
    );

    mockNow(new Date("2026-06-10T00:00:00.000Z"));
    const current = await accept(
      client().feed({
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

    manifest = stableManifest("9.9.9", {
      "9.9.9": darwinArm64Release(
        "9.9.9",
        "https://github.com/vm0-ai/vm0/releases/download/desktop-v9.9.9/Zero-darwin-arm64-9.9.9.zip",
      ),
    });
    const cached = await accept(
      client().feed({
        params: { channel: "stable", platform: "darwin", arch: "arm64" },
      }),
      [200],
    );

    expect(cached.body.currentRelease).toBe("0.2.1");
    expect(manifestFetches).toBe(1);

    const previousUrl =
      "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.2.1/Zero-darwin-arm64-0.2.1.zip";
    manifest = stableManifest(
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
    );
    mockNow(new Date("2026-06-10T00:01:01.000Z"));

    const fallback = await accept(
      client().feed({
        params: { channel: "stable", platform: "darwin", arch: "arm64" },
      }),
      [200],
    );

    expect(fallback.body.currentRelease).toBe("0.2.1");
    expect(fallback.body.releases[0]?.updateTo.url).toBe(previousUrl);

    manifest = stableManifest("0.2.1", {
      "0.2.1": missingArm64Release("0.2.1"),
    });
    mockNow(new Date("2026-06-10T00:02:02.000Z"));

    const missingAsset = await accept(
      client().feed({
        params: { channel: "stable", platform: "darwin", arch: "arm64" },
      }),
      [404],
    );

    expect(missingAsset.body.error.code).toBe("NOT_FOUND");
    expect(manifestFetches).toBe(3);
  });
});
