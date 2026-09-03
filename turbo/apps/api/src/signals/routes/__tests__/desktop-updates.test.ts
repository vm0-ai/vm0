import { desktopUpdatesContract } from "@okouai/api-contracts/contracts/desktop-updates";
import { testDesktopUpdateManifestStateContract } from "@okouai/api-contracts/contracts/test-desktop-update-manifest-state";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { desktopUpdateRoutes } from "../desktop-updates";
import { testDesktopUpdateManifestStateRoutes } from "../test-desktop-update-manifest-state";

const TEST_APP_ROUTES = Object.freeze([...desktopUpdateRoutes]);

const context = testContext();
const OKOU_DESKTOP_UPDATE_MANIFEST_URL =
  "https://github.com/vm0-ai/vm0/releases/download/ai-okou-desktop-updates/ai-okou-desktop-update-manifest.json";
const LEGACY_OKOU_DESKTOP_UPDATE_MANIFEST_URL =
  "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-updates/okou-desktop-update-manifest.json";

interface DesktopUpdateRelease {
  readonly version: string;
  readonly name?: string;
  readonly notes?: string;
  readonly pubDate: string;
  readonly platforms: Record<string, Record<string, { readonly url: string }>>;
}

interface DesktopUpdateManifest {
  readonly schemaVersion: 1;
  readonly product?: "okou";
  readonly channels: Record<
    string,
    { readonly latest: string; readonly blocked?: readonly string[] }
  >;
  readonly releases: Record<string, DesktopUpdateRelease>;
}

function client() {
  return setupApp({ context, routes: desktopUpdateRoutes })(
    desktopUpdatesContract,
  );
}

function manifestStateClient() {
  return setupApp({ context, routes: testDesktopUpdateManifestStateRoutes })(
    testDesktopUpdateManifestStateContract,
  );
}

function appRequest(path: string): Promise<Response> {
  return Promise.resolve(
    createApp({ signal: context.signal, routes: TEST_APP_ROUTES }).request(
      path,
      { method: "GET" },
    ),
  );
}

function mockDesktopUpdateManifest(
  manifest: DesktopUpdateManifest,
  manifestUrl = OKOU_DESKTOP_UPDATE_MANIFEST_URL,
): void {
  server.use(
    http.get(manifestUrl, () => {
      return HttpResponse.json(manifest);
    }),
  );
}

function stableManifest(
  latest: string,
  releases: DesktopUpdateManifest["releases"],
  blocked: readonly string[] = [],
): DesktopUpdateManifest {
  return {
    schemaVersion: 1,
    product: "okou",
    channels: {
      stable: { latest, blocked: [...blocked] },
    },
    releases,
  };
}

function darwinArm64Release(version: string, url: string) {
  return {
    version,
    name: `Okou ${version}`,
    notes: `Release ${version}`,
    pubDate: "2026-06-08T00:00:00.000Z",
    platforms: {
      darwin: {
        arm64: { url },
      },
    },
  };
}

function legacyDarwinX64Release(version: string, url: string) {
  return {
    version,
    name: `Okou ${version}`,
    notes: `Release ${version}`,
    pubDate: "2026-06-08T00:00:00.000Z",
    platforms: {
      darwin: {
        x64: { url },
      },
    },
  };
}

function okouZipUrl(version: string): string {
  return `https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v${version}/Okou-darwin-arm64-${version}.zip`;
}

describe("desktop update routes", () => {
  beforeEach(async () => {
    await accept(manifestStateClient().reset({ body: {} }), [200]);
  });

  it("serves the no-store hard Zero migration policy", async () => {
    const response = await appRequest(
      "http://api.test/api/desktop/migration-policy",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toStrictEqual({
      schemaVersion: 1,
      mode: "hard",
    });
  });

  // #28465 moved these two routes off `/api/okou/**` to the neutral path, and
  // #31088 removed the branded compatibility rows that kept the branded forms
  // answering — #31090 then removed the mechanism itself — so the neutral path
  // is the only one either route serves.
  //
  // The update line is asserted alongside the path, because the move alone
  // would have changed it: the neutral path has to serve the final
  // `ai-okou-desktop` line rather than the pre-adoption `okou` line it
  // succeeded. Both Okou manifests are mocked at different versions, so reading
  // the wrong one resolves to the wrong release and fails here rather than
  // 404ing. Every expectation is written out rather than derived from the path
  // under test, which would assert nothing.
  //
  // The unqualified DMG route is what the Zero migration wall's `Download Okou`
  // button opens and what the bridge compiled into installed Zero builds
  // hard-codes, so this case guards a live migration dependency.
  it("serves the moved desktop routes on the neutral path", async () => {
    mockDesktopUpdateManifest(
      stableManifest("0.12.0", {
        "0.12.0": darwinArm64Release("0.12.0", okouZipUrl("0.12.0")),
      }),
      LEGACY_OKOU_DESKTOP_UPDATE_MANIFEST_URL,
    );
    mockDesktopUpdateManifest(
      stableManifest("1.2.3", {
        "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
      }),
    );

    const releaseResponse = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/arm64/release",
    );

    expect(releaseResponse.status).toBe(302);
    expect(releaseResponse.headers.get("Location")).toBe(
      "https://github.com/vm0-ai/vm0/releases/tag/okou-desktop-v1.2.3",
    );
    expect(releaseResponse.headers.get("Cache-Control")).toBe("no-store");

    const dmgResponse = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/arm64/dmg",
    );

    expect(dmgResponse.status).toBe(302);
    expect(dmgResponse.headers.get("Location")).toBe(
      "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.dmg",
    );
    expect(dmgResponse.headers.get("Cache-Control")).toBe("no-store");
  });

  it("caches the desktop manifest until the 60-second ttl expires", async () => {
    const initialNow = Date.parse("2026-06-08T00:00:00.000Z");

    await withMockNowForTest(initialNow, async () => {
      mockDesktopUpdateManifest(
        stableManifest("0.2.1", {
          "0.2.1": darwinArm64Release("0.2.1", okouZipUrl("0.2.1")),
        }),
      );

      const firstResponse = await accept(
        client().productFeed({
          params: {
            product: "ai-okou-desktop",
            channel: "stable",
            platform: "darwin",
            arch: "arm64",
          },
        }),
        [200],
      );
      expect(firstResponse.body.currentRelease).toBe("0.2.1");

      mockDesktopUpdateManifest(
        stableManifest("0.2.2", {
          "0.2.2": darwinArm64Release("0.2.2", okouZipUrl("0.2.2")),
        }),
      );
      mockNow(initialNow + 59_999);

      const cachedResponse = await accept(
        client().productFeed({
          params: {
            product: "ai-okou-desktop",
            channel: "stable",
            platform: "darwin",
            arch: "arm64",
          },
        }),
        [200],
      );
      expect(cachedResponse.body.currentRelease).toBe("0.2.1");

      mockNow(initialNow + 60_000);

      const refreshedResponse = await accept(
        client().productFeed({
          params: {
            product: "ai-okou-desktop",
            channel: "stable",
            platform: "darwin",
            arch: "arm64",
          },
        }),
        [200],
      );
      expect(refreshedResponse.body.currentRelease).toBe("0.2.2");
    });
  });

  it("serves an Okou release only from the isolated Okou manifest", async () => {
    const zipUrl = okouZipUrl("1.2.3");
    mockDesktopUpdateManifest(
      stableManifest("1.2.3", {
        "1.2.3": darwinArm64Release("1.2.3", zipUrl),
      }),
    );

    const response = await accept(
      client().productFeed({
        params: {
          product: "ai-okou-desktop",
          channel: "stable",
          platform: "darwin",
          arch: "arm64",
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      currentRelease: "1.2.3",
      releases: [
        {
          version: "1.2.3",
          updateTo: {
            name: "Okou 1.2.3",
            version: "1.2.3",
            pub_date: "2026-06-08T00:00:00.000Z",
            url: zipUrl,
            notes: "Release 1.2.3",
          },
        },
      ],
    });
  });

  it("redirects the final Okou line to final-identity release assets", async () => {
    mockDesktopUpdateManifest(
      stableManifest("1.2.3", {
        "1.2.3": darwinArm64Release("1.2.3", okouZipUrl("1.2.3")),
      }),
    );

    const releaseResponse = await appRequest(
      "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/release",
    );
    expect(releaseResponse.status).toBe(302);
    expect(releaseResponse.headers.get("Location")).toBe(
      "https://github.com/vm0-ai/vm0/releases/tag/okou-desktop-v1.2.3",
    );

    const dmgResponse = await appRequest(
      "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/dmg",
    );
    expect(dmgResponse.status).toBe(302);
    expect(dmgResponse.headers.get("Location")).toBe(
      "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.dmg",
    );
  });

  it("returns not found for the retired desktop update lines", async () => {
    for (const line of ["okou", "zero"]) {
      for (const suffix of ["release", "dmg", "RELEASES.json"]) {
        const response = await appRequest(
          `http://api.test/api/desktop/updates/${line}/stable/darwin/arm64/${suffix}`,
        );

        expect(response.status).toBe(404);
      }
    }
  });

  it("does not serve a Zero artifact from the final Okou feed", async () => {
    mockDesktopUpdateManifest(
      stableManifest("1.2.3", {
        "1.2.3": darwinArm64Release(
          "1.2.3",
          "https://github.com/vm0-ai/vm0/releases/download/desktop-v1.2.3/Zero-darwin-arm64-1.2.3.zip",
        ),
      }),
    );

    const response = await accept(
      client().productFeed({
        params: {
          product: "ai-okou-desktop",
          channel: "stable",
          platform: "darwin",
          arch: "arm64",
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects the retired macOS x64 update feed", async () => {
    mockDesktopUpdateManifest(
      stableManifest("0.2.1", {
        "0.2.1": legacyDarwinX64Release(
          "0.2.1",
          "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v0.2.1/Okou-darwin-x64-0.2.1.zip",
        ),
      }),
    );

    const response = await appRequest(
      "http://api.test/api/desktop/updates/ai-okou-desktop/stable/darwin/x64/RELEASES.json",
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("rejects the retired macOS x64 dmg download", async () => {
    mockDesktopUpdateManifest(
      stableManifest("0.12.0", {
        "0.12.0": legacyDarwinX64Release(
          "0.12.0",
          "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v0.12.0/Okou-darwin-x64-0.12.0.zip",
        ),
      }),
    );

    const response = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/x64/dmg",
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("does not return a blocked latest release", async () => {
    const previousUrl = okouZipUrl("0.2.1");
    mockDesktopUpdateManifest(
      stableManifest(
        "0.2.2",
        {
          "0.2.1": darwinArm64Release("0.2.1", previousUrl),
          "0.2.2": darwinArm64Release("0.2.2", okouZipUrl("0.2.2")),
          "0.3.0": darwinArm64Release("0.3.0", okouZipUrl("0.3.0")),
        },
        ["0.2.2"],
      ),
    );

    const response = await accept(
      client().productFeed({
        params: {
          product: "ai-okou-desktop",
          channel: "stable",
          platform: "darwin",
          arch: "arm64",
        },
      }),
      [200],
    );

    expect(response.body.currentRelease).toBe("0.2.1");
    expect(response.body.releases[0]?.updateTo.url).toBe(previousUrl);
  });

  it("returns not found when the manifest has no matching asset", async () => {
    mockDesktopUpdateManifest(
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
      client().productFeed({
        params: {
          product: "ai-okou-desktop",
          channel: "stable",
          platform: "darwin",
          arch: "arm64",
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns not found when no dmg release is available", async () => {
    mockDesktopUpdateManifest(
      stableManifest("0.11.2", {
        "0.11.2": darwinArm64Release("0.11.2", okouZipUrl("0.11.2")),
      }),
    );

    const response = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/arm64/dmg",
    );

    expect(response.status).toBe(404);
  });
});
