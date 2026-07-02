import { presentationImagesContract } from "@vm0/api-contracts/contracts/presentation-images";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { now } from "../../external/time";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const routeMocks = createZeroRouteMocks(context);
const UNSPLASH_SEARCH_URL = "https://api.unsplash.com/search/photos";
const PEXELS_SEARCH_URL = "https://api.pexels.com/v1/search";

interface PresentationImagesFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
}

function createFixture(): PresentationImagesFixture {
  return {
    orgId: "org_presentation_images",
    userId: "user_presentation_images",
    runId: "run_presentation_images",
  };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroToken(
  fixture: PresentationImagesFixture,
  capabilities: readonly ZeroCapability[] = ["file:write"],
): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: fixture.userId,
    orgId: fixture.orgId,
    runId: fixture.runId,
    capabilities,
    iat: seconds,
    exp: seconds + 60,
  });
}

async function enableUnsplashPreferred(
  fixture: PresentationImagesFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(
    context,
    { userId: fixture.userId, orgId: fixture.orgId },
    { [FeatureSwitchKey.PresentationImageUnsplashPreferred]: true },
  );
}

describe("POST /api/presentation/images/resolve", () => {
  it("resolves image briefs through Unsplash with per-request query dedupe", async () => {
    const fixture = createFixture();
    routeMocks.clerk.session(fixture.userId, fixture.orgId);
    mockEnv("UNSPLASH_ACCESS_KEY", "test-unsplash-key");
    await enableUnsplashPreferred(fixture);
    const searchQueries: string[] = [];
    const downloadPhotoIds: string[] = [];

    server.use(
      http.get(UNSPLASH_SEARCH_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Client-ID test-unsplash-key",
        );
        const url = new URL(request.url);
        const query = url.searchParams.get("query");
        const orientation = url.searchParams.get("orientation");
        if (!query) {
          return HttpResponse.json({ results: [] });
        }

        searchQueries.push(`${query}:${orientation ?? ""}`);
        if (query === "modern office") {
          return HttpResponse.json({
            results: [
              {
                urls: {
                  regular: "https://images.unsplash.com/photo-office",
                },
                links: {
                  html: "https://unsplash.com/photos/office-photo",
                  download_location:
                    "https://api.unsplash.com/photos/office-photo/download",
                },
                user: {
                  name: "Office Photographer",
                  links: { html: "https://unsplash.com/@office" },
                },
                alt_description: "A modern office",
                width: 1200,
                height: 800,
                color: "#aabbcc",
                blur_hash: "hash-office",
              },
            ],
          });
        }

        if (query === "forest path") {
          expect(orientation).toBe("landscape");
          return HttpResponse.json({
            results: [
              {
                urls: {
                  regular: "https://images.unsplash.com/photo-forest",
                },
                links: {
                  html: "https://unsplash.com/photos/forest-photo",
                  download_location:
                    "https://api.unsplash.com/photos/forest-photo/download",
                },
                user: {
                  name: "Forest Photographer",
                  links: { html: "https://unsplash.com/@forest" },
                },
                description: "A forest path",
                width: 1600,
                height: 900,
              },
            ],
          });
        }

        return HttpResponse.json({ results: [] });
      }),
      http.get(
        "https://api.unsplash.com/photos/:photoId/download",
        ({ params, request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Client-ID test-unsplash-key",
          );
          downloadPhotoIds.push(String(params.photoId));
          return HttpResponse.json({
            url: "https://images.unsplash.com/tracked",
          });
        },
      ),
    );

    const client = setupApp({ context })(presentationImagesContract);
    const response = await accept(
      client.resolve({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          items: [
            { path: "$.pages[0].visual", query: "modern office" },
            { path: "$.pages[1].visual", query: "modern office" },
            {
              path: "$.pages[2].visual",
              query: "forest path",
              intent: "section divider landscape",
              orientation: "landscape",
            },
          ],
        },
      }),
      [200],
    );

    expect(searchQueries).toStrictEqual([
      "modern office:",
      "forest path:landscape",
    ]);
    expect(downloadPhotoIds).toStrictEqual(["office-photo", "forest-photo"]);
    expect(response.body.items).toStrictEqual([
      {
        path: "$.pages[0].visual",
        query: "modern office",
        status: "resolved",
        asset: {
          src: "https://images.unsplash.com/photo-office",
          alt: "A modern office",
          source: "unsplash",
          sourceName: "Unsplash",
          sourceUrl:
            "https://unsplash.com/photos/office-photo?utm_source=vm0_presentation_image_resolver&utm_medium=referral",
          unsplashUrl:
            "https://unsplash.com/?utm_source=vm0_presentation_image_resolver&utm_medium=referral",
          photographerName: "Office Photographer",
          photographerUrl:
            "https://unsplash.com/@office?utm_source=vm0_presentation_image_resolver&utm_medium=referral",
          license: "Unsplash",
          width: 1200,
          height: 800,
          color: "#aabbcc",
          blurHash: "hash-office",
        },
      },
      {
        path: "$.pages[1].visual",
        query: "modern office",
        status: "resolved",
        asset: {
          src: "https://images.unsplash.com/photo-office",
          alt: "A modern office",
          source: "unsplash",
          sourceName: "Unsplash",
          sourceUrl:
            "https://unsplash.com/photos/office-photo?utm_source=vm0_presentation_image_resolver&utm_medium=referral",
          unsplashUrl:
            "https://unsplash.com/?utm_source=vm0_presentation_image_resolver&utm_medium=referral",
          photographerName: "Office Photographer",
          photographerUrl:
            "https://unsplash.com/@office?utm_source=vm0_presentation_image_resolver&utm_medium=referral",
          license: "Unsplash",
          width: 1200,
          height: 800,
          color: "#aabbcc",
          blurHash: "hash-office",
        },
      },
      {
        path: "$.pages[2].visual",
        query: "forest path",
        status: "resolved",
        asset: {
          src: "https://images.unsplash.com/photo-forest",
          alt: "A forest path",
          source: "unsplash",
          sourceName: "Unsplash",
          sourceUrl:
            "https://unsplash.com/photos/forest-photo?utm_source=vm0_presentation_image_resolver&utm_medium=referral",
          unsplashUrl:
            "https://unsplash.com/?utm_source=vm0_presentation_image_resolver&utm_medium=referral",
          photographerName: "Forest Photographer",
          photographerUrl:
            "https://unsplash.com/@forest?utm_source=vm0_presentation_image_resolver&utm_medium=referral",
          license: "Unsplash",
          width: 1600,
          height: 900,
        },
      },
    ]);
  });

  it("returns unresolved items when Unsplash has no matching result", async () => {
    const fixture = createFixture();
    routeMocks.clerk.session(fixture.userId, fixture.orgId);
    mockEnv("UNSPLASH_ACCESS_KEY", "test-unsplash-key");
    await enableUnsplashPreferred(fixture);
    server.use(
      http.get(UNSPLASH_SEARCH_URL, () => {
        return HttpResponse.json({ results: [] });
      }),
    );

    const client = setupApp({ context })(presentationImagesContract);
    const response = await accept(
      client.resolve({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          items: [{ path: "$.pages[0].visual", query: "missing subject" }],
        },
      }),
      [200],
    );

    expect(response.body.items).toStrictEqual([
      {
        path: "$.pages[0].visual",
        query: "missing subject",
        status: "unresolved",
        error: {
          code: "NO_RESULTS",
          message: 'No Unsplash image matched "missing subject"',
        },
      },
    ]);
  });

  it("returns unresolved items when the Unsplash request fails", async () => {
    const fixture = createFixture();
    routeMocks.clerk.session(fixture.userId, fixture.orgId);
    mockEnv("UNSPLASH_ACCESS_KEY", "test-unsplash-key");
    await enableUnsplashPreferred(fixture);
    server.use(
      http.get(UNSPLASH_SEARCH_URL, () => {
        return HttpResponse.error();
      }),
    );

    const client = setupApp({ context })(presentationImagesContract);
    const response = await accept(
      client.resolve({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          items: [{ path: "$.pages[0].visual", query: "network failure" }],
        },
      }),
      [200],
    );

    expect(response.body.items).toStrictEqual([
      {
        path: "$.pages[0].visual",
        query: "network failure",
        status: "unresolved",
        error: {
          code: "PROVIDER_ERROR",
          message: 'Unsplash search failed for "network failure"',
        },
      },
    ]);
  });

  it("returns 503 when no image provider is configured", async () => {
    const fixture = createFixture();
    routeMocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(presentationImagesContract);
    const response = await accept(
      client.resolve({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          items: [{ path: "$.pages[0].visual", query: "modern office" }],
        },
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Presentation image resolution is not configured",
        code: "NOT_CONFIGURED",
      },
    });
  });

  it("resolves directly through Pexels when the switch is off", async () => {
    const fixture = createFixture();
    routeMocks.clerk.session(fixture.userId, fixture.orgId);
    mockEnv("UNSPLASH_ACCESS_KEY", "test-unsplash-key");
    mockEnv("PEXELS_API_KEY", "test-pexels-key");

    let unsplashCalled = false;
    const pexelsQueries: string[] = [];
    server.use(
      http.get(UNSPLASH_SEARCH_URL, () => {
        unsplashCalled = true;
        return HttpResponse.json({ results: [] });
      }),
      http.get(PEXELS_SEARCH_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("test-pexels-key");
        const url = new URL(request.url);
        pexelsQueries.push(url.searchParams.get("query") ?? "");
        return HttpResponse.json({
          photos: [
            {
              url: "https://www.pexels.com/photo/city-skyline-123/",
              src: {
                large: "https://images.pexels.com/photo-city-large",
                medium: "https://images.pexels.com/photo-city-medium",
              },
              photographer: "City Shooter",
              photographer_url: "https://www.pexels.com/@cityshooter",
              alt: "A city skyline",
              width: 1500,
              height: 1000,
              avg_color: "#334455",
            },
          ],
        });
      }),
    );

    const client = setupApp({ context })(presentationImagesContract);
    const response = await accept(
      client.resolve({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          items: [{ path: "$.pages[0].visual", query: "city skyline" }],
        },
      }),
      [200],
    );

    // Switch off: Unsplash is never consulted even though its key is present.
    expect(unsplashCalled).toBe(false);
    expect(pexelsQueries).toStrictEqual(["city skyline"]);
    expect(response.body.items).toStrictEqual([
      {
        path: "$.pages[0].visual",
        query: "city skyline",
        status: "resolved",
        asset: {
          src: "https://images.pexels.com/photo-city-large",
          alt: "A city skyline",
          source: "pexels",
          sourceName: "Pexels",
          sourceUrl: "https://www.pexels.com/photo/city-skyline-123/",
          unsplashUrl: "https://www.pexels.com/photo/city-skyline-123/",
          photographerName: "City Shooter",
          photographerUrl: "https://www.pexels.com/@cityshooter",
          license: "Pexels",
          width: 1500,
          height: 1000,
          color: "#334455",
        },
      },
    ]);
  });

  it("falls back to Pexels when the switch is on and Unsplash has no result", async () => {
    const fixture = createFixture();
    routeMocks.clerk.session(fixture.userId, fixture.orgId);
    mockEnv("UNSPLASH_ACCESS_KEY", "test-unsplash-key");
    mockEnv("PEXELS_API_KEY", "test-pexels-key");
    await enableUnsplashPreferred(fixture);

    let unsplashCalled = false;
    server.use(
      http.get(UNSPLASH_SEARCH_URL, () => {
        unsplashCalled = true;
        return HttpResponse.json({ results: [] });
      }),
      http.get(PEXELS_SEARCH_URL, () => {
        return HttpResponse.json({
          photos: [
            {
              url: "https://www.pexels.com/photo/forest-999/",
              src: { large: "https://images.pexels.com/photo-forest-large" },
              photographer: "Forest Fan",
              photographer_url: "https://www.pexels.com/@forestfan",
              alt: "A misty forest",
              width: 1600,
              height: 900,
            },
          ],
        });
      }),
    );

    const client = setupApp({ context })(presentationImagesContract);
    const response = await accept(
      client.resolve({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          items: [{ path: "$.pages[0].visual", query: "forest" }],
        },
      }),
      [200],
    );

    // Switch on: Unsplash is tried first, then Pexels resolves the fallback.
    expect(unsplashCalled).toBe(true);
    expect(response.body.items).toStrictEqual([
      {
        path: "$.pages[0].visual",
        query: "forest",
        status: "resolved",
        asset: {
          src: "https://images.pexels.com/photo-forest-large",
          alt: "A misty forest",
          source: "pexels",
          sourceName: "Pexels",
          sourceUrl: "https://www.pexels.com/photo/forest-999/",
          unsplashUrl: "https://www.pexels.com/photo/forest-999/",
          photographerName: "Forest Fan",
          photographerUrl: "https://www.pexels.com/@forestfan",
          license: "Pexels",
          width: 1600,
          height: 900,
        },
      },
    ]);
  });

  it("requires file write capability for zero tokens", async () => {
    const fixture = createFixture();
    mockEnv("UNSPLASH_ACCESS_KEY", "test-unsplash-key");
    const client = setupApp({ context })(presentationImagesContract);
    const response = await accept(
      client.resolve({
        headers: {
          authorization: `Bearer ${zeroToken(fixture, ["file:read"])}`,
        },
        body: {
          items: [{ path: "$.pages[0].visual", query: "modern office" }],
        },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: file:write",
        code: "FORBIDDEN",
      },
    });
  });
});
