import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { mockOptionalEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { hostedTextFile } from "./helpers/api-bdd-chat-files";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";

/*
FILE-01 host APIs plus BILL-02/CHAIN-BILLING-MEDIA maps billing. Replaces the
legacy zero-host.test.ts and zero-maps.test.ts route tests:
- Hosted-site/deployment/artifact DB-row asserts are replaced by the files GET
  and complete/redeploy response bodies; maps org-credit row asserts are
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
const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";

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

    const slugPattern = new RegExp(`^${site}-[a-f0-9]{8}-[a-f0-9]{8}$`);
    expect(first.publicSlug).toMatch(slugPattern);
    expect(second.publicSlug).toMatch(slugPattern);
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
    // Onboarding without an entitlement moves the org to pro-suspend.
    await bdd.setupOnboarding(actor, { displayName: "BDD Host Suspended" });
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

  it("redeploys presentation HTML in place and rejects non-presentation sites [HOST-C]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const actor = bdd.user();
    api.captureHostedSitesS3();

    const site = `bdd-deck-${randomUUID().slice(0, 8)}`;
    const prepared = await api.prepareHostedSite(actor, {
      site,
      slugSuffix: "release-01",
      artifactKind: "presentation-html",
      spaFallback: true,
      files: [
        hostedTextFile("/index.html", "<main>original deck</main>"),
        hostedTextFile(
          "/assets/cat style.css",
          "body { color: black; }",
          "text/css",
        ),
      ],
    });
    await api.completeHostedSite(actor, prepared.deploymentId);

    const capture = api.captureHostedSitesS3();
    const redeployed = await api.redeployPresentationHtml(actor, {
      url: prepared.url,
      html: "<!doctype html><html><body>edited deck</body></html>",
    });
    expect(redeployed.url).toBe(prepared.url);
    expect(redeployed.publicSlug).toBe(prepared.publicSlug);
    expect(redeployed.siteId).toBe(prepared.siteId);
    expect(redeployed.deploymentId).not.toBe(prepared.deploymentId);
    expect(redeployed.status).toBe("ready");

    const newPrefix = `sites/${prepared.publicSlug}/deployments/${redeployed.deploymentId}`;
    expect(capture.copies).toStrictEqual([
      {
        key: `${newPrefix}/assets/cat style.css`,
        copySource: `test-hosted-sites/sites/${prepared.publicSlug}/deployments/${prepared.deploymentId}/assets/cat%20style.css`,
      },
    ]);
    expect(
      capture.puts.map((put) => {
        return put.key;
      }),
    ).toStrictEqual([
      `${newPrefix}/index.html`,
      `${newPrefix}/manifest.json`,
      `sites/${prepared.publicSlug}/active.json`,
    ]);
    const pointerPut = capture.puts.find((put) => {
      return put.key === `sites/${prepared.publicSlug}/active.json`;
    });
    if (!pointerPut) {
      throw new Error("Expected the redeploy to rewrite the active pointer");
    }
    expect(JSON.parse(pointerPut.body)).toMatchObject({
      version: 1,
      publicSlug: prepared.publicSlug,
      deploymentId: redeployed.deploymentId,
      spaFallback: true,
    });

    const listed = await api.readHostedSiteFiles(actor, prepared.publicSlug);
    expect(listed.deploymentId).toBe(redeployed.deploymentId);
    expect(
      listed.files.map((file) => {
        return file.path;
      }),
    ).toStrictEqual(["/assets/cat style.css", "/index.html"]);

    const plainSite = `bdd-plain-${randomUUID().slice(0, 8)}`;
    const plain = await api.prepareHostedSite(actor, {
      site: plainSite,
      slugSuffix: "release-01",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<main>plain</main>")],
    });
    await api.completeHostedSite(actor, plain.deploymentId);
    const rejected = await api.requestRedeployPresentationHtml(
      actor,
      { url: plain.url, html: "<p>edited</p>" },
      [400],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.message).toBe(
      "Hosted site is not a presentation HTML artifact",
    );
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

  it("generates presentation speaker notes through OpenRouter and rejects invalid model output [HOST-E]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const actor = bdd.user();
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-speaker-notes-key");

    let upstreamAuthorization: string | null = null;
    let upstreamPrompt: string | null = null;
    server.use(
      http.post(OPENROUTER_CHAT_COMPLETIONS_URL, async ({ request }) => {
        upstreamAuthorization = request.headers.get("authorization");
        const requestBody = (await request.json()) as {
          readonly messages?: readonly { readonly content?: string }[];
        };
        upstreamPrompt = requestBody.messages?.at(-1)?.content ?? null;
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  kind: "presentation-speaker-notes-patch",
                  version: 1,
                  slides: [
                    {
                      slideId: "slide-2",
                      speakerNotes: "Walk through the roadmap.",
                    },
                  ],
                }),
              },
            },
          ],
        });
      }),
    );

    const generated = await api.requestGenerateSpeakerNotes(
      actor,
      {
        html: '<!doctype html><html><body><section data-slide-id="slide-2">Roadmap</section></body></html>',
        mode: "fill-empty",
      },
      [200],
    );
    expect(generated.body).toStrictEqual({
      kind: "presentation-speaker-notes-patch",
      version: 1,
      slides: [
        { slideId: "slide-2", speakerNotes: "Walk through the roadmap." },
      ],
    });
    expect(upstreamAuthorization).toBe("Bearer bdd-speaker-notes-key");
    expect(upstreamPrompt).toContain("slide-2");

    server.use(
      http.post(OPENROUTER_CHAT_COMPLETIONS_URL, () => {
        return HttpResponse.json({
          choices: [
            { finish_reason: "stop", message: { content: "not json" } },
          ],
        });
      }),
    );
    const invalid = await api.requestGenerateSpeakerNotes(
      actor,
      {
        html: "<!doctype html><html><body><section>Roadmap</section></body></html>",
        mode: "fill-empty",
      },
      [400],
    );
    expectApiError(invalid.body);
    expect(invalid.body.error.message).toBe(
      "Speaker notes generation returned invalid JSON",
    );
  });
});

describe("BILL-02/CHAIN-BILLING-MEDIA: maps operations settle credits through public reads", () => {
  it("charges marked-up Google Maps prices across geocode, directions, places, and details [MAPS-A]", async () => {
    const bdd = createBddApi(context);
    const billing = createBillingMediaApi(context);
    const runs = createRunsAutomationsApi(context);
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

    // Onboarded-but-unentitled orgs are credit-gated before Google is called.
    const unentitled = bdd.user();
    await billing.setupOnboarding(unentitled, {
      displayName: "BDD Maps No Credits",
    });
    const gatedSearch = await billing.requestMapsPlacesSearch(
      unentitled,
      { query: "coffee", limit: 3 },
      [402],
    );
    expectApiError(gatedSearch.body);
    expect(gatedSearch.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(searchMasks).toHaveLength(2);
  });
});

describe("CHAIN-BILLING-MEDIA/FILE-01: run-scoped zero-token attribution", () => {
  it("attributes maps usage and hosted-site artifacts to a claimed run through its real zero token [HOST-B/MAPS-B]", async () => {
    const bdd = createBddApi(context);
    const api = createHostMapsBddApi(context);
    const billing = createBillingMediaApi(context);
    const runs = createRunsAutomationsApi(context);
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
    expect(prepared.publicSlug).toMatch(
      new RegExp(`^${site}-[a-f0-9]{8}-run-01$`),
    );

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
