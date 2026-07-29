import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createMapsBillingApi } from "./helpers/api-bdd-maps-billing";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";

/*
FILE-01 host APIs plus BILL-02/CHAIN-BILLING-MEDIA maps billing. Replaces the
legacy zero-host.test.ts and zero-maps.test.ts route tests:
- Hosted-site/deployment/artifact DB-row asserts are replaced by the files GET
  and complete response bodies; maps org-credit row asserts are
  replaced by billing-status deltas.
- The run-artifact chain uses the run's real zero token from the runner claim
  (`claim.environment.ZERO_TOKEN`) instead of seeding runs and rewriting
  deployment rows.
- Maps gates (NOT_CONFIGURED / 402 / invalid location) stay owned by
  billing-usage-media.bdd.test.ts BILL-02; the slug-suffix reuse and
  missing-index validations stay owned by chat-files.bdd.test.ts FILE-01.
- "zero token without maps:read -> 403" is dropped: every production zero
  token carries maps:read unconditionally (generateZeroToken), so the case is
  not API-constructible.
*/

const context = testContext();

const GOOGLE_GEOCODING_URL =
  "https://maps.googleapis.com/maps/api/geocode/json";
const GOOGLE_DIRECTIONS_URL =
  "https://maps.googleapis.com/maps/api/directions/json";
const GOOGLE_PLACES_SEARCH_TEXT_URL =
  "https://places.googleapis.com/v1/places:searchText";
const GOOGLE_PLACE_DETAILS_URL =
  "https://places.googleapis.com/v1/places/ChIJtest";
const OPENSTREETMAP_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
async function setHostedArtifactVersions(
  actor: ApiTestUser,
  enabled: boolean,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected hosted artifact actor to have an org");
  }
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId },
    { [FeatureSwitchKey.HostedArtifactVersions]: enabled },
  );
}

function expectPublicSlugSegment(value: string): void {
  expect(value).toMatch(/^[a-f0-9]{8}$/);
}

function expectHostedSitePublicSlug(
  value: string,
  site: string,
  slugSuffix?: string,
): void {
  const prefix = `${site}-`;
  expect(value.startsWith(prefix)).toBeTruthy();
  const rest = value.slice(prefix.length);
  if (slugSuffix === undefined) {
    const segments = rest.split("-");
    expect(segments).toHaveLength(2);
    expectPublicSlugSegment(segments[0] ?? "");
    expectPublicSlugSegment(segments[1] ?? "");
    return;
  }

  const suffix = `-${slugSuffix}`;
  expect(rest.endsWith(suffix)).toBeTruthy();
  expectPublicSlugSegment(rest.slice(0, -suffix.length));
}

function geocodeOkHandler(requests: URL[]) {
  return http.get(GOOGLE_GEOCODING_URL, ({ request }) => {
    requests.push(new URL(request.url));
    return HttpResponse.json({
      status: "OK",
      results: [
        {
          formatted_address: "1 Infinite Loop, Cupertino, CA",
          geometry: { location: { lat: 37.3317, lng: -122.0301 } },
        },
      ],
    });
  });
}

describe("FILE-01: hosted-site deployments through host APIs", () => {
  it("creates immutable versions behind a simple alias and promotes only the newest completed version [HOST-A]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected versioned host actor to have an org");
    }
    await setHostedArtifactVersions(actor, true);
    const capture = api.captureHostedSitesS3();
    await upsertOrgPlanEntitlementFixture({ orgId: actor.orgId });

    const site = `bdd-versioned-${randomUUID().slice(0, 8)}`;
    const body = {
      site,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>versioned</main>")],
    };

    const first = await api.prepareHostedSite(actor, body);
    const second = await api.prepareHostedSite(actor, body);

    expect(first.siteId).toBe(second.siteId);
    expect(first.publicSlug).toBe(site);
    expect(second.publicSlug).toBe(site);
    expect(first.url).toBe(second.url);
    expect(first.aliasUrl).toBe(first.url);
    expect(second.aliasUrl).toBe(second.url);
    expect(first.deploymentVersion).toBe(1);
    expect(second.deploymentVersion).toBe(2);
    expect(first.artifactUrl).not.toBe(second.artifactUrl);
    expect(new URL(first.artifactUrl ?? "").hostname).toBe(
      `dpl-${first.deploymentId}.${new URL(first.url).hostname.slice(site.length + 1)}`,
    );

    const completedSecond = await api.completeHostedSite(
      actor,
      second.deploymentId,
    );
    const completedFirst = await api.completeHostedSite(
      actor,
      first.deploymentId,
    );
    expect(completedSecond).toMatchObject({
      deploymentVersion: 2,
      artifactUrl: second.artifactUrl,
      aliasUrl: second.url,
      isActive: true,
      activeDeploymentVersion: 2,
    });
    expect(completedFirst).toMatchObject({
      deploymentVersion: 1,
      artifactUrl: first.artifactUrl,
      aliasUrl: first.url,
      isActive: false,
      activeDeploymentVersion: 2,
    });

    const versionPrefix = `sites/orgs/${actor.orgId}/${site}/versions`;
    expect(
      capture.puts.map((put) => {
        return put.key;
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        `${versionPrefix}/1/manifest.json`,
        `${versionPrefix}/2/manifest.json`,
        `sites/deployments/${first.deploymentId}.json`,
        `sites/deployments/${second.deploymentId}.json`,
      ]),
    );
    expect(
      capture.puts.filter((put) => {
        return put.key === `sites/${site}/active.json`;
      }),
    ).toHaveLength(1);

    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/hosted-sites/download?sig=bdd",
    );
    const active = await api.readHostedSiteFiles(actor, site);
    const versionOne = await api.readHostedSiteFiles(actor, site, 1);
    const immutableVersionOne = await api.readHostedSiteFiles(
      actor,
      `dpl-${first.deploymentId}`,
    );
    expect(active.deploymentId).toBe(second.deploymentId);
    expect(active.deploymentVersion).toBe(2);
    expect(versionOne.deploymentId).toBe(first.deploymentId);
    expect(versionOne.artifactUrl).toBe(first.artifactUrl);
    expect(immutableVersionOne.deploymentId).toBe(first.deploymentId);
    expect(immutableVersionOne.artifactUrl).toBe(first.artifactUrl);

    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/hosted-sites/upload?sig=bdd",
    );
    const third = await api.prepareHostedSite(actor, {
      ...body,
      files: [
        hostedTextFile(
          "/index.html",
          "<!doctype html><main>version three</main>",
        ),
      ],
    });
    const completedThird = await api.completeHostedSite(
      actor,
      third.deploymentId,
    );
    expect(completedThird).toMatchObject({
      siteId: first.siteId,
      publicSlug: site,
      deploymentVersion: 3,
      aliasUrl: first.url,
      isActive: true,
      activeDeploymentVersion: 3,
    });
    expect(third.deploymentId).not.toBe(first.deploymentId);
    expect(third.artifactUrl).not.toBe(first.artifactUrl);
    expect(third.artifactUrl).not.toBe(second.artifactUrl);
    expect(third.uploads).toStrictEqual([
      {
        path: "/index.html",
        uploadUrl: "https://r2.example.com/hosted-sites/upload?sig=bdd",
      },
    ]);

    const history = await api.readHostedSiteDeployments(actor, site);
    expect(history).toMatchObject({
      siteId: first.siteId,
      site,
      publicSlug: site,
      aliasUrl: first.url,
      activeDeploymentId: third.deploymentId,
      activeDeploymentVersion: 3,
    });
    expect(
      history.deployments
        .map((deployment) => {
          return deployment.deploymentVersion;
        })
        .sort(),
    ).toStrictEqual([1, 2, 3]);
    expect(
      history.deployments.filter((deployment) => {
        return deployment.isActive;
      }),
    ).toStrictEqual([
      expect.objectContaining({
        deploymentId: third.deploymentId,
        deploymentVersion: 3,
      }),
    ]);
  });

  it("keeps an adopted site versioned after the feature switch is disabled [HOST-A]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected versioned host actor to have an org");
    }
    await setHostedArtifactVersions(actor, true);
    await upsertOrgPlanEntitlementFixture({ orgId: actor.orgId });
    const capture = api.captureHostedSitesS3();
    const site = `bdd-sticky-versioned-${randomUUID().slice(0, 8)}`;
    const body = {
      site,
      artifactKind: "hosted-site" as const,
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>version one</main>")],
    };

    const first = await api.prepareHostedSite(actor, body);
    await api.completeHostedSite(actor, first.deploymentId);
    await setHostedArtifactVersions(actor, false);

    const second = await api.prepareHostedSite(actor, body);
    expect(second).toMatchObject({
      siteId: first.siteId,
      publicSlug: first.publicSlug,
      deploymentVersion: 2,
      aliasUrl: first.aliasUrl,
    });
    expect(second.artifactUrl).not.toBe(first.artifactUrl);
    const completedSecond = await api.completeHostedSite(
      actor,
      second.deploymentId,
    );
    expect(completedSecond).toMatchObject({
      deploymentVersion: 2,
      isActive: true,
      activeDeploymentVersion: 2,
    });

    const third = await api.prepareHostedSite(actor, {
      ...body,
      files: [
        hostedTextFile(
          "/index.html",
          "<!doctype html><main>version three</main>",
        ),
      ],
    });
    const completedThird = await api.completeHostedSite(
      actor,
      third.deploymentId,
    );
    expect(completedThird).toMatchObject({
      siteId: first.siteId,
      publicSlug: first.publicSlug,
      deploymentVersion: 3,
      aliasUrl: first.aliasUrl,
      isActive: true,
      activeDeploymentVersion: 3,
    });

    const versionPrefix = `sites/orgs/${actor.orgId}/${site}/versions`;
    expect(
      capture.puts.map((put) => {
        return put.key;
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        `${versionPrefix}/1/manifest.json`,
        `${versionPrefix}/2/manifest.json`,
        `${versionPrefix}/3/manifest.json`,
      ]),
    );
    expect(
      capture.puts.filter((put) => {
        return put.key === `sites/${first.publicSlug}/active.json`;
      }),
    ).toHaveLength(3);
  });

  it("adds a four-character hash only when the simple alias is already occupied [HOST-A]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    api.captureHostedSitesS3();

    const legacyActor = bdd.user();
    const occupied = await api.prepareHostedSite(legacyActor, {
      site: `bdd-alias-owner-${randomUUID().slice(0, 8)}`,
      slugSuffix: "fixed",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>occupied</main>")],
    });

    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected collision actor to have an org");
    }
    await setHostedArtifactVersions(actor, true);
    const capture = api.captureHostedSitesS3();
    await upsertOrgPlanEntitlementFixture({ orgId: actor.orgId });
    const versioned = await api.prepareHostedSite(actor, {
      site: occupied.publicSlug,
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>collision</main>")],
    });
    expect(versioned.publicSlug).toMatch(
      new RegExp(`^${occupied.publicSlug}-[a-z0-9]{4}$`, "u"),
    );
    expect(versioned.deploymentVersion).toBe(1);
    expect(versioned.artifactUrl).toContain(`dpl-${versioned.deploymentId}.`);

    await api.completeHostedSite(actor, versioned.deploymentId);
    expect(
      capture.puts.map((put) => {
        return put.key;
      }),
    ).toContain(
      `sites/orgs/${actor.orgId}/${occupied.publicSlug}/versions/1/manifest.json`,
    );

    const disabledHistory = await api.requestHostedSiteDeployments(
      legacyActor,
      occupied.publicSlug,
      [403],
    );
    expectApiError(disabledHistory.body);
    expect(disabledHistory.body.error.code).toBe("FORBIDDEN");
  });

  it("allocates random public slugs, serves owner file metadata, and gates suspended orgs [HOST-A]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const actor = bdd.user();
    // First test in the file: install the S3 boundary explicitly before any
    // host call (mock defaults only arrive in afterEach resets).
    const capture = api.captureHostedSitesS3();

    const site = `bdd-host-${randomUUID().slice(0, 8)}`;
    const indexFile = hostedTextFile("/index.html", "<main>BDD host</main>");
    const scriptFile = hostedTextFile(
      "/assets/app.js",
      "console.log('bdd host');",
      "application/javascript",
    );
    const files = [indexFile, scriptFile];
    const body = {
      site,
      artifactKind: "hosted-site" as const,
      spaFallback: true,
      files,
    };

    const first = await api.prepareHostedSite(actor, body);
    const second = await api.prepareHostedSite(actor, body);

    expectHostedSitePublicSlug(first.publicSlug, site);
    expectHostedSitePublicSlug(second.publicSlug, site);
    expect(second.publicSlug).not.toBe(first.publicSlug);
    expect(second.url).not.toBe(first.url);
    expect(second.siteId).toBe(first.siteId);
    expect(
      first.uploads.map((upload) => {
        return upload.path;
      }),
    ).toStrictEqual(["/index.html", "/assets/app.js"]);
    expect(context.mocks.s3.clientConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: {
          accessKeyId: "test-hosted-sites-access-key",
          secretAccessKey: "test-hosted-sites-secret-key",
        },
      }),
    );

    const missingKey = `sites/${first.publicSlug}/deployments/${first.deploymentId}/assets/app.js`;
    capture.missingKeys.add(missingKey);
    const notUploaded = await api.requestCompleteHostedSite(
      actor,
      first.deploymentId,
      [400],
    );
    expectApiError(notUploaded.body);
    expect(notUploaded.body.error.message).toBe(
      "Hosted deployment file was not uploaded: /assets/app.js",
    );
    capture.missingKeys.delete(missingKey);

    const completed = await api.completeHostedSite(actor, second.deploymentId);
    expect(completed).toStrictEqual({
      siteId: first.siteId,
      deploymentId: second.deploymentId,
      publicSlug: second.publicSlug,
      url: second.url,
      status: "ready",
    });

    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/hosted-sites/download?sig=bdd",
    );
    const listed = await api.readHostedSiteFiles(actor, second.publicSlug);
    expect(listed).toMatchObject({
      siteId: first.siteId,
      deploymentId: second.deploymentId,
      publicSlug: second.publicSlug,
      url: second.url,
      fileCount: 2,
      size: indexFile.size + scriptFile.size,
    });
    expect(
      listed.files.map((file) => {
        return {
          path: file.path,
          size: file.size,
          contentType: file.contentType,
          downloadUrl: file.downloadUrl,
        };
      }),
    ).toStrictEqual([
      {
        path: "/assets/app.js",
        size: scriptFile.size,
        contentType: "application/javascript",
        downloadUrl: "https://r2.example.com/hosted-sites/download?sig=bdd",
      },
      {
        path: "/index.html",
        size: indexFile.size,
        contentType: "text/html; charset=utf-8",
        downloadUrl: "https://r2.example.com/hosted-sites/download?sig=bdd",
      },
    ]);

    const outsider = bdd.user();
    const crossOrg = await api.requestHostedSiteFiles(
      outsider,
      second.publicSlug,
      [404],
    );
    expectApiError(crossOrg.body);
    expect(crossOrg.body.error.message).toBe("Hosted site not found");

    const third = await api.prepareHostedSite(actor, body);
    const onboardingCompleted = await bdd.completeOnboarding(actor);
    expect(onboardingCompleted.status).toBe(200);
    if (!actor.orgId) {
      throw new Error("Expected suspended host actor to have an org");
    }
    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "pro-suspend",
      credits: 0,
    });
    const suspendedComplete = await api.requestCompleteHostedSite(
      actor,
      third.deploymentId,
      [402],
    );
    expectApiError(suspendedComplete.body);
    expect(suspendedComplete.body.error.code).toBe("INSUFFICIENT_CREDITS");

    const suspendedPrepare = await api.requestPrepareHostedSite(
      actor,
      body,
      [402],
    );
    expectApiError(suspendedPrepare.body);
    expect(suspendedPrepare.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("rejects unauthenticated prepares and oversized public slugs [HOST-D]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const files = [hostedTextFile("/index.html", "<main>auth matrix</main>")];

    const unauthenticated = await api.requestPrepareHostedSite(
      null,
      {
        site: "bdd-anon-site",
        artifactKind: "hosted-site",
        spaFallback: false,
        files,
      },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const actor = bdd.user();
    const tooLong = await api.requestPrepareHostedSite(
      actor,
      {
        site: "a".repeat(63),
        slugSuffix: "b".repeat(32),
        artifactKind: "hosted-site",
        spaFallback: false,
        files,
      },
      [400],
    );
    expectApiError(tooLong.body);
    expect(tooLong.body.error.code).toBe("BAD_REQUEST");
    expect(tooLong.body.error.message).toContain("96");
  });

  it("charges marked-up Google Maps prices across geocode, directions, places, and details [MAPS-A]", async () => {
    const bdd = createBddApi(context);
    const billing = createMapsBillingApi(context);
    const runs = createRunsApi(context);
    const admin = bdd.user();
    bdd.acceptAgentStorageWrites();
    await runs.grantProEntitlement(admin);
    billing.configureMapsProvider();

    const geocodeRequests: URL[] = [];
    const directionsRequests: URL[] = [];
    const searchMasks: (string | null)[] = [];
    const searchBodies: unknown[] = [];
    const detailMasks: (string | null)[] = [];
    server.use(
      geocodeOkHandler(geocodeRequests),
      http.get(GOOGLE_DIRECTIONS_URL, ({ request }) => {
        directionsRequests.push(new URL(request.url));
        return HttpResponse.json({
          status: "OK",
          routes: [{ legs: [], overview_polyline: { points: "encoded" } }],
        });
      }),
      http.post(GOOGLE_PLACES_SEARCH_TEXT_URL, async ({ request }) => {
        searchMasks.push(request.headers.get("x-goog-fieldmask"));
        searchBodies.push(await request.json());
        return HttpResponse.json({
          places: [{ id: "ChIJtest", displayName: { text: "Coffee" } }],
        });
      }),
      http.get(GOOGLE_PLACE_DETAILS_URL, ({ request }) => {
        detailMasks.push(request.headers.get("x-goog-fieldmask"));
        return HttpResponse.json({
          id: "ChIJtest",
          displayName: { text: "Coffee" },
        });
      }),
    );

    const before = await billing.readBillingStatus(admin);

    const geocode = await billing.requestMapsGeocode(
      admin,
      { address: "1 Infinite Loop, Cupertino", region: "US" },
      [200],
    );
    expect(geocode.body).toMatchObject({
      operation: "geocode",
      provider: "google-maps",
      billingCategory: "geocoding",
      billingQuantity: 1,
      creditsCharged: 6,
    });
    const geocodeUrl = geocodeRequests.at(0);
    expect(geocodeUrl?.searchParams.get("key")).toBe("test-google-maps-key");
    expect(geocodeUrl?.searchParams.get("address")).toBe(
      "1 Infinite Loop, Cupertino",
    );
    expect(geocodeUrl?.searchParams.get("region")).toBe("US");

    const reverse = await billing.requestMapsReverseGeocode(
      admin,
      { lat: 37.7749, lng: -122.4194 },
      [200],
    );
    expect(reverse.body).toMatchObject({
      operation: "reverse-geocode",
      billingCategory: "geocoding",
      creditsCharged: 6,
    });
    expect(geocodeRequests.at(1)?.searchParams.get("latlng")).toBe(
      "37.7749,-122.4194",
    );

    const advanced = await billing.requestMapsDirections(
      admin,
      {
        origin: "SFO",
        destination: "Mountain View",
        mode: "driving",
        departureTime: "now",
      },
      [200],
    );
    expect(advanced.body).toMatchObject({
      operation: "directions",
      billingCategory: "routes.directions.advanced",
      creditsCharged: 12,
    });
    expect(directionsRequests.at(0)?.searchParams.get("departure_time")).toBe(
      "now",
    );

    const base = await billing.requestMapsDirections(
      admin,
      { origin: "SFO", destination: "Mountain View" },
      [200],
    );
    expect(base.body).toMatchObject({
      billingCategory: "routes.directions",
      creditsCharged: 6,
    });
    expect(
      directionsRequests.at(1)?.searchParams.get("departure_time"),
    ).toBeNull();

    const proSearch = await billing.requestMapsPlacesSearch(
      admin,
      {
        query: "coffee",
        location: "37.7749,-122.4194",
        radius: 1000,
        limit: 3,
        region: "US",
      },
      [200],
    );
    expect(proSearch.body).toMatchObject({
      operation: "places.search",
      billingCategory: "places.text_search.pro",
      creditsCharged: 39,
    });
    const proMask = searchMasks.at(0) ?? "";
    expect(proMask).toContain("places.displayName");
    expect(proMask).not.toContain("places.priceLevel");
    expect(searchBodies.at(0)).toStrictEqual({
      textQuery: "coffee",
      maxResultCount: 3,
      regionCode: "US",
      locationBias: {
        circle: {
          center: { latitude: 37.7749, longitude: -122.4194 },
          radius: 1000,
        },
      },
    });

    const enterpriseSearch = await billing.requestMapsPlacesSearch(
      admin,
      { query: "coffee", limit: 3, fields: "enterprise" },
      [200],
    );
    expect(enterpriseSearch.body).toMatchObject({
      billingCategory: "places.text_search.enterprise",
      creditsCharged: 42,
    });
    expect((searchMasks.at(1) ?? "").split(",")).toStrictEqual(
      expect.arrayContaining([
        "places.displayName",
        "places.googleMapsUri",
        "places.priceLevel",
        "places.priceRange",
      ]),
    );

    const proDetails = await billing.requestMapsPlacesDetails(
      admin,
      { placeId: "places/ChIJtest", fields: "pro" },
      [200],
    );
    expect(proDetails.body).toMatchObject({
      operation: "places.details",
      billingCategory: "places.details.pro",
      creditsCharged: 21,
    });
    expect(detailMasks.at(0)).toContain("displayName");
    expect(detailMasks.at(0)).not.toContain("priceLevel");

    const enterpriseDetails = await billing.requestMapsPlacesDetails(
      admin,
      { placeId: "places/ChIJtest", fields: "enterprise" },
      [200],
    );
    expect(enterpriseDetails.body).toMatchObject({
      billingCategory: "places.details.enterprise",
      creditsCharged: 24,
    });
    expect((detailMasks.at(1) ?? "").split(",")).toStrictEqual(
      expect.arrayContaining([
        "displayName",
        "googleMapsUri",
        "priceLevel",
        "priceRange",
        "rating",
        "userRatingCount",
        "regularOpeningHours",
        "currentOpeningHours",
        "websiteUri",
        "nationalPhoneNumber",
      ]),
    );

    const settled = await billing.readBillingStatus(admin);
    expect(settled.credits).toBe(
      before.credits - (6 + 6 + 12 + 6 + 39 + 42 + 21 + 24),
    );

    server.use(
      http.get(GOOGLE_GEOCODING_URL, () => {
        return HttpResponse.json(
          { error_message: "API key quota exceeded" },
          { status: 500 },
        );
      }),
    );
    const upstreamFailure = await billing.requestMapsGeocode(
      admin,
      { address: "1 Infinite Loop, Cupertino" },
      [502],
    );
    expectApiError(upstreamFailure.body);
    expect(upstreamFailure.body.error.code).toBe("GOOGLE_MAPS_ERROR");
    expect(upstreamFailure.body.error.message).toBe("API key quota exceeded");

    const unchanged = await billing.readBillingStatus(admin);
    expect(unchanged.credits).toBe(settled.credits);

    // Complete directly because reading onboarding status grants limited-free
    // credits. Onboarded-but-unentitled orgs are gated before Google is called.
    const unentitled = bdd.user();
    const completed = await bdd.completeOnboarding(unentitled);
    expect(completed.status).toBe(200);
    expect((await billing.readBillingStatus(unentitled)).credits).toBe(0);
    const gatedSearch = await billing.requestMapsPlacesSearch(
      unentitled,
      { query: "coffee", limit: 3 },
      [402],
    );
    expectApiError(gatedSearch.body);
    expect(gatedSearch.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(searchMasks).toHaveLength(2);
  });

  it("charges OpenStreetMap download and PNG render usage [MAPS-OSM-A]", async () => {
    const bdd = createBddApi(context);
    const billing = createMapsBillingApi(context);
    const runs = createRunsApi(context);
    const admin = bdd.user();
    bdd.acceptAgentStorageWrites();
    await runs.grantProEntitlement(admin);

    const overpassBodies: string[] = [];
    server.use(
      http.post(OPENSTREETMAP_OVERPASS_URL, async ({ request }) => {
        overpassBodies.push(await request.text());
        return HttpResponse.json({
          elements: [
            {
              type: "way",
              id: 1,
              tags: { highway: "residential" },
              geometry: [
                { lat: 37.76, lon: -122.43 },
                { lat: 37.79, lon: -122.4 },
              ],
            },
            {
              type: "way",
              id: 2,
              tags: { building: "yes" },
              geometry: [
                { lat: 37.765, lon: -122.425 },
                { lat: 37.765, lon: -122.42 },
                { lat: 37.77, lon: -122.42 },
                { lat: 37.77, lon: -122.425 },
                { lat: 37.765, lon: -122.425 },
              ],
            },
          ],
        });
      }),
    );

    const before = await billing.readBillingStatus(admin);
    const bbox = {
      west: -122.43,
      south: 37.76,
      east: -122.4,
      north: 37.79,
    };

    const download = await billing.requestMapsOsmDownload(
      admin,
      { bbox, layers: ["roads", "buildings"] },
      [200],
    );
    expect(download.body).toMatchObject({
      operation: "osm.download",
      provider: "openstreetmap",
      billingCategory: "osm.download",
      billingQuantity: 1,
      creditsCharged: 1,
      result: {
        bbox,
        layers: ["roads", "buildings"],
        attribution: "© OpenStreetMap contributors",
        featureCount: 2,
        geojson: {
          type: "FeatureCollection",
        },
      },
    });
    const downloadQuery = new URLSearchParams(overpassBodies.at(0)).get("data");
    expect(downloadQuery).toContain('way["highway"]');
    expect(downloadQuery).toContain('way["building"]');

    const render = await billing.requestMapsOsmRender(
      admin,
      {
        bbox,
        layers: ["roads", "buildings"],
        width: 640,
        height: 480,
        style: "guide",
        markers: [{ lat: 37.7749, lng: -122.4194, label: "Market" }],
      },
      [200],
    );
    expect(render.body).toMatchObject({
      operation: "osm.render",
      provider: "openstreetmap",
      billingCategory: "osm.render.png",
      billingQuantity: 1,
      creditsCharged: 2,
      result: {
        bbox,
        layers: ["roads", "buildings"],
        width: 640,
        height: 480,
        style: "guide",
        attribution: "© OpenStreetMap contributors",
        featureCount: 2,
        image: {
          mimeType: "image/png",
        },
      },
    });
    if (!("result" in render.body)) {
      throw new Error("Expected OSM render to return a maps result");
    }
    const renderResult = render.body.result as {
      readonly image?: { readonly base64?: string };
    };
    expect(typeof renderResult.image?.base64).toBe("string");
    expect(
      Buffer.from(renderResult.image?.base64 ?? "", "base64")
        .subarray(1, 4)
        .toString("utf8"),
    ).toBe("PNG");
    const renderQuery = new URLSearchParams(overpassBodies.at(1)).get("data");
    expect(renderQuery).toContain('way["highway"]');
    expect(renderQuery).toContain('way["building"]');

    const settled = await billing.readBillingStatus(admin);
    expect(settled.credits).toBe(before.credits - (1 + 2));
  });
});

describe("CHAIN-BILLING-MEDIA/FILE-01: run-scoped zero-token attribution", () => {
  it("attributes maps usage and hosted-site artifacts to a claimed run through its real zero token [HOST-B/MAPS-B]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const billing = createMapsBillingApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD host maps agent",
      description: "Run-scoped maps and host attribution.",
      visibility: "private",
    });
    billing.configureMapsProvider();
    const geocodeRequests: URL[] = [];
    server.use(geocodeOkHandler(geocodeRequests));

    const created = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "attribute maps and host usage",
      modelProvider: "anthropic-api-key",
    });
    await runs.heartbeatRunner(runnerGroup);
    const poll = await runs.pollRunner(runnerGroup);
    expect(poll.body.job?.runId).toBe(created.runId);
    const claim = await runs.claimRunnerJob(created.runId);

    // The default zero-agent compose maps ZERO_TOKEN from the run secrets, so
    // the claimed execution context exposes the real run-scoped zero token.
    const zeroToken = claim.environment?.ZERO_TOKEN;
    if (!zeroToken) {
      throw new Error(
        "Expected claim.environment.ZERO_TOKEN to carry the run-scoped zero token",
      );
    }
    expect(zeroToken).toMatch(/^vm0_sandbox_/);
    expect(claim.secretValues ?? []).toContain(zeroToken);

    const before = await billing.readBillingStatus(actor);

    const geocode = await api.requestMapsGeocodeWithBearer(
      zeroToken,
      { address: "1 Infinite Loop, Cupertino" },
      [200],
    );
    expect(geocode.body).toMatchObject({
      operation: "geocode",
      billingCategory: "geocoding",
      creditsCharged: 6,
    });
    expect(geocodeRequests).toHaveLength(1);

    const bearer = { bearerToken: zeroToken };
    const site = `bdd-run-artifact-${randomUUID().slice(0, 8)}`;
    const prepared = await api.prepareHostedSite(bearer, {
      site,
      slugSuffix: "run-01",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>run artifact</main>")],
    });
    expectHostedSitePublicSlug(prepared.publicSlug, site, "run-01");

    const completed = await api.completeHostedSite(
      bearer,
      prepared.deploymentId,
    );
    expect(completed.status).toBe("ready");
    // Completing again exercises the idempotent artifact upsert.
    const recompleted = await api.completeHostedSite(
      bearer,
      prepared.deploymentId,
    );
    expect(recompleted).toStrictEqual(completed);

    const settled = await billing.readBillingStatus(actor);
    expect(settled.credits).toBe(before.credits - 6);

    await runs.requestCancelRun(actor, created.runId, [200]);
    const cancelled = await runs.readRun(actor, created.runId);
    expect(cancelled.status).toBe("cancelled");
  });
});
