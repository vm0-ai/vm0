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
const DESKTOP_UPDATE_MANIFEST_URL =
  "https://github.com/vm0-ai/vm0/releases/download/desktop-updates/desktop-update-manifest.json";
const OKOU_DESKTOP_UPDATE_MANIFEST_URL =
  "https://github.com/vm0-ai/vm0/releases/download/ai-okou-desktop-updates/ai-okou-desktop-update-manifest.json";

interface DesktopUpdateRelease {
  readonly version: string;
  readonly name?: string;
  readonly notes?: string;
  readonly pubDate: string;
  readonly platforms: Record<string, Record<string, { readonly url: string }>>;
}

interface DesktopUpdateManifest {
  readonly schemaVersion: 1;
  readonly product?: "zero" | "okou";
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
  manifestUrl = DESKTOP_UPDATE_MANIFEST_URL,
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
    channels: {
      stable: { latest, blocked: [...blocked] },
    },
    releases,
  };
}

function darwinArm64Release(
  version: string,
  url: string,
  productName = "Zero",
) {
  return {
    version,
    name:
      productName === "Okou"
        ? `Okou ${version}`
        : `Zero Computer Use ${version}`,
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
    name: `Zero Computer Use ${version}`,
    notes: `Release ${version}`,
    pubDate: "2026-06-08T00:00:00.000Z",
    platforms: {
      darwin: {
        x64: { url },
      },
    },
  };
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

  it("redirects the release page route to the current stable desktop release", async () => {
    mockDesktopUpdateManifest(
      stableManifest("0.2.1", {
        "0.2.1": darwinArm64Release(
          "0.2.1",
          "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.2.1/Zero-darwin-arm64-0.2.1.zip",
        ),
      }),
    );

    const response = await appRequest(
      "http://api.test/api/zero/desktop/updates/stable/darwin/arm64/release",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://github.com/vm0-ai/vm0/releases/tag/desktop-v0.2.1",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("redirects the dmg route to the current stable desktop dmg asset", async () => {
    mockDesktopUpdateManifest(
      stableManifest("0.12.0", {
        "0.12.0": darwinArm64Release(
          "0.12.0",
          "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.12.0/Zero-darwin-arm64-0.12.0.zip",
        ),
      }),
    );

    const response = await appRequest(
      "http://api.test/api/zero/desktop/updates/stable/darwin/arm64/dmg",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.12.0/Zero-darwin-arm64-0.12.0.dmg",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  // #28465 moved these two routes off `/api/okou/**`. Installed desktop builds
  // poll the branded form from a constant compiled into the shipped binary and
  // a released platform tab holds it until it reloads, so both branded forms
  // have to keep resolving through `MIGRATED_BRANDED_PATHS`.
  //
  // The update line each path serves is asserted alongside the path, because a
  // path move alone would have changed it: the line is derived from the request
  // namespace, so the neutral path has to inherit the Okou line the `okou` form
  // served rather than fall through to Zero. Every expectation is written out
  // rather than taken from `apiNamespaceAliasPaths`, which returns a neutral
  // path unchanged and so would assert nothing.
  it("serves the moved desktop routes on the neutral and both branded paths", async () => {
    mockDesktopUpdateManifest(
      stableManifest("0.12.0", {
        "0.12.0": darwinArm64Release(
          "0.12.0",
          "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.12.0/Zero-darwin-arm64-0.12.0.zip",
        ),
      }),
    );
    mockDesktopUpdateManifest(
      {
        ...stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release(
            "1.2.3",
            "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.zip",
            "Okou",
          ),
        }),
        product: "okou",
      },
      OKOU_DESKTOP_UPDATE_MANIFEST_URL,
    );

    const expectations = [
      {
        prefix: "/api",
        release:
          "https://github.com/vm0-ai/vm0/releases/tag/okou-desktop-v1.2.3",
        dmg: "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.dmg",
      },
      {
        prefix: "/api/okou",
        release:
          "https://github.com/vm0-ai/vm0/releases/tag/okou-desktop-v1.2.3",
        dmg: "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.dmg",
      },
      {
        prefix: "/api/zero",
        release: "https://github.com/vm0-ai/vm0/releases/tag/desktop-v0.12.0",
        dmg: "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.12.0/Zero-darwin-arm64-0.12.0.dmg",
      },
    ] as const;

    for (const { prefix, release, dmg } of expectations) {
      const releaseResponse = await appRequest(
        `http://api.test${prefix}/desktop/updates/stable/darwin/arm64/release`,
      );

      expect({ prefix, status: releaseResponse.status }).toStrictEqual({
        prefix,
        status: 302,
      });
      expect({
        prefix,
        location: releaseResponse.headers.get("Location"),
      }).toStrictEqual({ prefix, location: release });

      const dmgResponse = await appRequest(
        `http://api.test${prefix}/desktop/updates/stable/darwin/arm64/dmg`,
      );

      expect({ prefix, status: dmgResponse.status }).toStrictEqual({
        prefix,
        status: 302,
      });
      expect({
        prefix,
        location: dmgResponse.headers.get("Location"),
      }).toStrictEqual({ prefix, location: dmg });
    }
  });

  it("serves the current stable macOS arm64 update from the manifest", async () => {
    const zipUrl =
      "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.2.1/Zero-darwin-arm64-0.2.1.zip";
    mockDesktopUpdateManifest(
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

  it("caches the desktop manifest until the 60-second ttl expires", async () => {
    const initialNow = Date.parse("2026-06-08T00:00:00.000Z");
    const firstZipUrl =
      "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.2.1/Zero-darwin-arm64-0.2.1.zip";
    const refreshedZipUrl =
      "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.2.2/Zero-darwin-arm64-0.2.2.zip";

    await withMockNowForTest(initialNow, async () => {
      mockDesktopUpdateManifest(
        stableManifest("0.2.1", {
          "0.2.1": darwinArm64Release("0.2.1", firstZipUrl),
        }),
      );

      const firstResponse = await accept(
        client().feed({
          params: { channel: "stable", platform: "darwin", arch: "arm64" },
        }),
        [200],
      );
      expect(firstResponse.body.currentRelease).toBe("0.2.1");

      mockDesktopUpdateManifest(
        stableManifest("0.2.2", {
          "0.2.2": darwinArm64Release("0.2.2", refreshedZipUrl),
        }),
      );
      mockNow(initialNow + 59_999);

      const cachedResponse = await accept(
        client().feed({
          params: { channel: "stable", platform: "darwin", arch: "arm64" },
        }),
        [200],
      );
      expect(cachedResponse.body.currentRelease).toBe("0.2.1");

      mockNow(initialNow + 60_000);

      const refreshedResponse = await accept(
        client().feed({
          params: { channel: "stable", platform: "darwin", arch: "arm64" },
        }),
        [200],
      );
      expect(refreshedResponse.body.currentRelease).toBe("0.2.2");
    });
  });

  it("serves an Okou release only from the isolated Okou manifest", async () => {
    const zipUrl =
      "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.zip";
    mockDesktopUpdateManifest(
      {
        ...stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", zipUrl, "Okou"),
        }),
        product: "okou",
      },
      OKOU_DESKTOP_UPDATE_MANIFEST_URL,
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
    const zipUrl =
      "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.zip";
    mockDesktopUpdateManifest(
      {
        ...stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", zipUrl, "Okou"),
        }),
        product: "okou",
      },
      OKOU_DESKTOP_UPDATE_MANIFEST_URL,
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

  it("serves branded Okou routes from the final identity line after cutover", async () => {
    const zipUrl =
      "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.zip";
    mockDesktopUpdateManifest(
      {
        ...stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release("1.2.3", zipUrl, "Okou"),
        }),
        product: "okou",
      },
      OKOU_DESKTOP_UPDATE_MANIFEST_URL,
    );

    const brandedReleaseResponse = await appRequest(
      "http://api.test/api/okou/desktop/updates/stable/darwin/arm64/release",
    );
    expect(brandedReleaseResponse.status).toBe(302);
    expect(brandedReleaseResponse.headers.get("Location")).toBe(
      "https://github.com/vm0-ai/vm0/releases/tag/okou-desktop-v1.2.3",
    );

    const brandedDmgResponse = await appRequest(
      "http://api.test/api/okou/desktop/updates/stable/darwin/arm64/dmg",
    );
    expect(brandedDmgResponse.status).toBe(302);
    expect(brandedDmgResponse.headers.get("Location")).toBe(
      "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.dmg",
    );
  });

  it("returns not found for the retired pre-adoption Okou update line", async () => {
    for (const path of [
      "/api/desktop/updates/okou/stable/darwin/arm64/release",
      "/api/desktop/updates/okou/stable/darwin/arm64/dmg",
      "/api/desktop/updates/okou/stable/darwin/arm64/RELEASES.json",
    ]) {
      const response = await appRequest(`http://api.test${path}`);

      expect(response.status).toBe(404);
    }
  });

  it("does not serve a Zero artifact from the final Okou feed", async () => {
    mockDesktopUpdateManifest(
      {
        ...stableManifest("1.2.3", {
          "1.2.3": darwinArm64Release(
            "1.2.3",
            "https://github.com/vm0-ai/vm0/releases/download/desktop-v1.2.3/Zero-darwin-arm64-1.2.3.zip",
          ),
        }),
        product: "okou",
      },
      OKOU_DESKTOP_UPDATE_MANIFEST_URL,
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

  it("does not serve an Okou artifact from the legacy Zero feed", async () => {
    mockDesktopUpdateManifest(
      stableManifest("1.2.3", {
        "1.2.3": darwinArm64Release(
          "1.2.3",
          "https://github.com/vm0-ai/vm0/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.zip",
          "Okou",
        ),
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

  it("rejects the retired macOS x64 update feed", async () => {
    const zipUrl =
      "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.2.1/Zero-darwin-x64-0.2.1.zip";
    mockDesktopUpdateManifest(
      stableManifest("0.2.1", {
        "0.2.1": legacyDarwinX64Release("0.2.1", zipUrl),
      }),
    );

    const response = await appRequest(
      "http://api.test/api/desktop/updates/stable/darwin/x64/RELEASES.json",
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("rejects the retired macOS x64 dmg download", async () => {
    const zipUrl =
      "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.12.0/Zero-darwin-x64-0.12.0.zip";
    mockDesktopUpdateManifest(
      stableManifest("0.12.0", {
        "0.12.0": legacyDarwinX64Release("0.12.0", zipUrl),
      }),
    );

    const response = await appRequest(
      "http://api.test/api/zero/desktop/updates/stable/darwin/x64/dmg",
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("does not return a blocked latest release", async () => {
    const previousUrl =
      "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.2.1/Zero-darwin-arm64-0.2.1.zip";
    mockDesktopUpdateManifest(
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
      client().feed({
        params: { channel: "stable", platform: "darwin", arch: "arm64" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns not found when no dmg release is available", async () => {
    const zipUrl =
      "https://github.com/vm0-ai/vm0/releases/download/desktop-v0.11.2/Zero-darwin-arm64-0.11.2.zip";
    mockDesktopUpdateManifest(
      stableManifest("0.11.2", {
        "0.11.2": darwinArm64Release("0.11.2", zipUrl),
      }),
    );

    const response = await appRequest(
      "http://api.test/api/zero/desktop/updates/stable/darwin/arm64/dmg",
    );

    expect(response.status).toBe(404);
  });
});
