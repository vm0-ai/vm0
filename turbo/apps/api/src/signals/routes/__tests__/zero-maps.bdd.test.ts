import { randomUUID } from "node:crypto";

import { zeroMapsContract } from "@vm0/api-contracts/contracts/zero-maps";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { createStore } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/zero-org-membership";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-maps.test.ts`. The
// 10 legacy `it()`s collapse into 3 BDD `it()`s:
// (1) geocoding + directions chain (200 geocodes
// through Google Maps and charges geocoding → 200
// charges advanced directions when departure time is
// requested),
// (2) places search + details chain (200 places
// search Pro → 200 places search Enterprise → 402
// Enterprise credits pre-check → 402 below operation
// price → 200 Pro details → 200 Enterprise details),
// (3) auth + not-configured chain (403 zero token
// without maps:read → 503 platform key not configured).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const GOOGLE_MAPS_KEY = "test-google-maps-key";
const GOOGLE_GEOCODING_URL =
  "https://maps.googleapis.com/maps/api/geocode/json";
const GOOGLE_DIRECTIONS_URL =
  "https://maps.googleapis.com/maps/api/directions/json";
const GOOGLE_PLACES_SEARCH_TEXT_URL =
  "https://places.googleapis.com/v1/places:searchText";
const GOOGLE_PLACE_DETAILS_URL =
  "https://places.googleapis.com/v1/places/ChIJtest";

interface MapsFixture {
  readonly orgId: string;
  readonly userId: string;
}

const MAPS_PRICING_ROWS = [
  ["geocoding", 6],
  ["routes.directions", 6],
  ["routes.directions.advanced", 12],
  ["places.text_search.pro", 39],
  ["places.text_search.enterprise", 42],
  ["places.details.essentials", 6],
  ["places.details.pro", 21],
  ["places.details.enterprise", 24],
] as const;

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroToken(
  fixture: MapsFixture,
  capabilities: readonly ZeroCapability[],
): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: fixture.userId,
    orgId: fixture.orgId,
    runId: randomUUID(),
    capabilities,
    iat: seconds,
    exp: seconds + 60,
  });
}

async function ensureMapsPricing(): Promise<void> {
  await store
    .set(writeDb$)
    .insert(usagePricing)
    .values(
      MAPS_PRICING_ROWS.map(([category, unitPrice]) => {
        return {
          kind: "maps",
          provider: "google-maps",
          category,
          unitPrice,
          unitSize: 1,
        };
      }),
    )
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: sql`EXCLUDED.unit_price`,
        unitSize: sql`EXCLUDED.unit_size`,
        updatedAt: sql`now()`,
      },
    });
}

async function seedMapsFixture(credits = 1000): Promise<MapsFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const writeDb = store.set(writeDb$);

  await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );
  await writeDb.insert(orgMetadata).values({
    orgId,
    tier: "free",
    credits,
  });
  await writeDb.insert(orgMembersMetadata).values({
    orgId,
    userId,
  });
  await ensureMapsPricing();

  return { orgId, userId };
}

async function deleteMapsFixture(fixture: MapsFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(usageEvent)
    .where(
      and(
        eq(usageEvent.orgId, fixture.orgId),
        eq(usageEvent.userId, fixture.userId),
      ),
    );
  await writeDb
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, fixture.orgId),
        eq(orgMembersMetadata.userId, fixture.userId),
      ),
    );
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await store.set(deleteOrgMembership$, fixture, context.signal);
}

async function orgCredits(orgId: string): Promise<number | undefined> {
  const [row] = await store
    .set(writeDb$)
    .select({ credits: orgMetadata.credits })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId));
  return row?.credits;
}

function fieldMaskParts(fieldMask: string | null): string[] {
  if (fieldMask === null) {
    throw new Error("Google Places field mask was not sent");
  }
  return fieldMask.split(",");
}

function apiClient() {
  return setupApp({ context })(zeroMapsContract);
}

describe("BDD POST /api/zero/maps/* — geocoding + directions chain", () => {
  const track = createFixtureTracker(deleteMapsFixture);

  beforeEach(() => {
    mockEnv("ZERO_MAPS_GOOGLE_MAPS_TOKEN", GOOGLE_MAPS_KEY);
  });

  it("gwt-wt-wt: 200 geocodes through Google Maps and charges geocoding → 200 charges advanced directions when departure time is requested", async () => {
    // Given: a seeded maps fixture + an admin Clerk
    // session + the Google geocoding MSW handler
    // returning a single result.

    // When + Then: 200 — Google Maps receives the
    // expected key/address/region query params + the
    // response carries geocoding billing + 6 credits
    // are charged + the org's credits drop from 1000
    // to 994.
    const geocodeFixture = await track(seedMapsFixture());
    mocks.clerk.session(
      geocodeFixture.userId,
      geocodeFixture.orgId,
      "org:admin",
    );
    let geocodeUrl: URL | undefined;
    server.use(
      http.get(GOOGLE_GEOCODING_URL, ({ request }) => {
        geocodeUrl = new URL(request.url);
        return HttpResponse.json({
          status: "OK",
          results: [
            {
              formatted_address: "1 Infinite Loop, Cupertino, CA",
              geometry: { location: { lat: 37.3317, lng: -122.0301 } },
            },
          ],
        });
      }),
    );

    const geocodeResponse = await accept(
      apiClient().geocode({
        headers: authHeaders(),
        body: { address: "1 Infinite Loop, Cupertino", region: "US" },
      }),
      [200],
    );

    expect(geocodeUrl?.searchParams.get("key")).toBe(GOOGLE_MAPS_KEY);
    expect(geocodeUrl?.searchParams.get("address")).toBe(
      "1 Infinite Loop, Cupertino",
    );
    expect(geocodeUrl?.searchParams.get("region")).toBe("US");
    expect(geocodeResponse.body).toMatchObject({
      operation: "geocode",
      provider: "google-maps",
      billingCategory: "geocoding",
      billingQuantity: 1,
      creditsCharged: 6,
    });
    await expect(orgCredits(geocodeFixture.orgId)).resolves.toBe(994);

    // Given: a seeded maps fixture + the Google
    // directions MSW handler returning a route + a
    // zero token with maps:read.

    // When + Then: 200 — Google Maps receives
    // `departure_time=now` + the response uses the
    // advanced directions billing category + 12
    // credits are charged.
    const directionsFixture = await track(seedMapsFixture());
    let directionsUrl: URL | undefined;
    server.use(
      http.get(GOOGLE_DIRECTIONS_URL, ({ request }) => {
        directionsUrl = new URL(request.url);
        return HttpResponse.json({
          status: "OK",
          routes: [{ legs: [], overview_polyline: { points: "encoded" } }],
        });
      }),
    );

    const directionsToken = zeroToken(directionsFixture, ["maps:read"]);
    const directionsResponse = await accept(
      apiClient().directions({
        headers: { authorization: `Bearer ${directionsToken}` },
        body: {
          origin: "SFO",
          destination: "Mountain View",
          mode: "driving",
          departureTime: "now",
        },
      }),
      [200],
    );

    expect(directionsUrl?.searchParams.get("departure_time")).toBe("now");
    expect(directionsResponse.body.billingCategory).toBe(
      "routes.directions.advanced",
    );
    expect(directionsResponse.body.creditsCharged).toBe(12);
  });
});

describe("BDD POST /api/zero/maps/* — places search + details chain", () => {
  const track = createFixtureTracker(deleteMapsFixture);

  beforeEach(() => {
    mockEnv("ZERO_MAPS_GOOGLE_MAPS_TOKEN", GOOGLE_MAPS_KEY);
  });

  it("gwt-wt-wt: 200 places search Pro → 200 places search Enterprise → 402 Enterprise credits pre-check → 402 below operation price → 200 Pro details → 200 Enterprise details", async () => {
    // Given: a seeded maps fixture + an admin Clerk
    // session + the Google places-search MSW
    // handler returning a single place.

    // When + Then: 200 — the field mask includes
    // displayName but not priceLevel + the request
    // body is shaped as expected + the response uses
    // places.text_search.pro + 39 credits are charged.
    const proSearchFixture = await track(seedMapsFixture());
    mocks.clerk.session(
      proSearchFixture.userId,
      proSearchFixture.orgId,
      "org:admin",
    );
    let proSearchBody: unknown;
    let proSearchFieldMask: string | null = null;
    server.use(
      http.post(GOOGLE_PLACES_SEARCH_TEXT_URL, async ({ request }) => {
        proSearchFieldMask = request.headers.get("x-goog-fieldmask");
        proSearchBody = await request.json();
        return HttpResponse.json({
          places: [
            {
              id: "ChIJtest",
              displayName: { text: "Coffee" },
              formattedAddress: "1 Market St, San Francisco, CA",
            },
          ],
        });
      }),
    );

    const proSearchResponse = await accept(
      apiClient().placesSearch({
        headers: authHeaders(),
        body: {
          query: "coffee",
          location: "37.7749,-122.4194",
          radius: 1000,
          limit: 3,
          region: "US",
        },
      }),
      [200],
    );

    expect(proSearchFieldMask).toContain("places.displayName");
    expect(proSearchFieldMask).not.toContain("places.priceLevel");
    expect(proSearchBody).toStrictEqual({
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
    expect(proSearchResponse.body.billingCategory).toBe(
      "places.text_search.pro",
    );
    expect(proSearchResponse.body.creditsCharged).toBe(39);

    // Given: a seeded maps fixture + the places-search
    // MSW handler returning an enterprise result.

    // When + Then: 200 — the field mask includes
    // enterprise fields + the response uses
    // places.text_search.enterprise + 42 credits are
    // charged + the org's credits drop from 1000 to
    // 958.
    const enterpriseSearchFixture = await track(seedMapsFixture());
    mocks.clerk.session(
      enterpriseSearchFixture.userId,
      enterpriseSearchFixture.orgId,
      "org:admin",
    );
    let enterpriseSearchFieldMask: string | null = null;
    server.use(
      http.post(GOOGLE_PLACES_SEARCH_TEXT_URL, ({ request }) => {
        enterpriseSearchFieldMask = request.headers.get("x-goog-fieldmask");
        return HttpResponse.json({
          places: [
            {
              id: "ChIJtest",
              displayName: { text: "Coffee" },
              googleMapsUri: "https://maps.google.com/?cid=test",
              priceLevel: "PRICE_LEVEL_MODERATE",
              priceRange: {
                startPrice: { currencyCode: "USD", units: "10" },
                endPrice: { currencyCode: "USD", units: "20" },
              },
            },
          ],
        });
      }),
    );

    const enterpriseSearchResponse = await accept(
      apiClient().placesSearch({
        headers: authHeaders(),
        body: { query: "coffee", limit: 3, fields: "enterprise" },
      }),
      [200],
    );

    expect(fieldMaskParts(enterpriseSearchFieldMask)).toStrictEqual(
      expect.arrayContaining([
        "places.displayName",
        "places.googleMapsUri",
        "places.priceLevel",
        "places.priceRange",
      ]),
    );
    expect(enterpriseSearchResponse.body.billingCategory).toBe(
      "places.text_search.enterprise",
    );
    expect(enterpriseSearchResponse.body.creditsCharged).toBe(42);
    await expect(orgCredits(enterpriseSearchFixture.orgId)).resolves.toBe(958);

    // Given: a seeded maps fixture with 39 credits +
    // an enterprise search request + the
    // places-search MSW handler tracking calls.

    // When + Then: 402 — INSUFFICIENT_CREDITS +
    // Google Maps is not contacted + the org's
    // credits stay at 39.
    const lowEnterpriseFixture = await track(seedMapsFixture(39));
    mocks.clerk.session(
      lowEnterpriseFixture.userId,
      lowEnterpriseFixture.orgId,
      "org:admin",
    );
    let enterpriseCalled = false;
    server.use(
      http.post(GOOGLE_PLACES_SEARCH_TEXT_URL, () => {
        enterpriseCalled = true;
        return HttpResponse.json({ places: [] });
      }),
    );

    const lowEnterpriseResponse = await accept(
      apiClient().placesSearch({
        headers: authHeaders(),
        body: { query: "coffee", limit: 5, fields: "enterprise" },
      }),
      [402],
    );

    expect(enterpriseCalled).toBeFalsy();
    expect(lowEnterpriseResponse.body.error.code).toBe("INSUFFICIENT_CREDITS");
    await expect(orgCredits(lowEnterpriseFixture.orgId)).resolves.toBe(39);

    // Given: a seeded maps fixture with 6 credits + a
    // Pro search request + the places-search MSW
    // handler tracking calls.

    // When + Then: 402 — INSUFFICIENT_CREDITS +
    // Google Maps is not contacted + the org's
    // credits stay at 6.
    const lowProFixture = await track(seedMapsFixture(6));
    mocks.clerk.session(lowProFixture.userId, lowProFixture.orgId, "org:admin");
    let proCalled = false;
    server.use(
      http.post(GOOGLE_PLACES_SEARCH_TEXT_URL, () => {
        proCalled = true;
        return HttpResponse.json({ places: [] });
      }),
    );

    const lowProResponse = await accept(
      apiClient().placesSearch({
        headers: authHeaders(),
        body: { query: "coffee", limit: 5 },
      }),
      [402],
    );

    expect(proCalled).toBeFalsy();
    expect(lowProResponse.body.error.code).toBe("INSUFFICIENT_CREDITS");
    await expect(orgCredits(lowProFixture.orgId)).resolves.toBe(6);

    // Given: a seeded maps fixture + the place
    // details MSW handler returning a basic
    // response.

    // When + Then: 200 — the field mask contains
    // displayName + the response uses
    // places.details.pro + 21 credits are charged.
    const proDetailsFixture = await track(seedMapsFixture());
    mocks.clerk.session(
      proDetailsFixture.userId,
      proDetailsFixture.orgId,
      "org:admin",
    );
    let proDetailsFieldMask: string | null = null;
    server.use(
      http.get(GOOGLE_PLACE_DETAILS_URL, ({ request }) => {
        proDetailsFieldMask = request.headers.get("x-goog-fieldmask");
        return HttpResponse.json({
          id: "ChIJtest",
          displayName: { text: "Coffee" },
          formattedAddress: "1 Market St, San Francisco, CA",
        });
      }),
    );

    const proDetailsResponse = await accept(
      apiClient().placesDetails({
        headers: authHeaders(),
        body: { placeId: "places/ChIJtest", fields: "pro" },
      }),
      [200],
    );

    expect(proDetailsFieldMask).toContain("displayName");
    expect(proDetailsResponse.body.billingCategory).toBe("places.details.pro");
    expect(proDetailsResponse.body.creditsCharged).toBe(21);

    // Given: a seeded maps fixture + the place
    // details MSW handler returning an enterprise
    // response.

    // When + Then: 200 — the field mask contains
    // every enterprise field + the response uses
    // places.details.enterprise + 24 credits are
    // charged + the org's credits drop from 1000 to
    // 976.
    const enterpriseDetailsFixture = await track(seedMapsFixture());
    mocks.clerk.session(
      enterpriseDetailsFixture.userId,
      enterpriseDetailsFixture.orgId,
      "org:admin",
    );
    let enterpriseDetailsFieldMask: string | null = null;
    server.use(
      http.get(GOOGLE_PLACE_DETAILS_URL, ({ request }) => {
        enterpriseDetailsFieldMask = request.headers.get("x-goog-fieldmask");
        return HttpResponse.json({
          id: "ChIJtest",
          displayName: { text: "Coffee" },
          priceLevel: "PRICE_LEVEL_MODERATE",
          priceRange: {
            startPrice: { currencyCode: "USD", units: "10" },
            endPrice: { currencyCode: "USD", units: "20" },
          },
          rating: 4.5,
          userRatingCount: 120,
          nationalPhoneNumber: "(415) 555-0100",
          websiteUri: "https://example.com",
        });
      }),
    );

    const enterpriseDetailsResponse = await accept(
      apiClient().placesDetails({
        headers: authHeaders(),
        body: { placeId: "places/ChIJtest", fields: "enterprise" },
      }),
      [200],
    );

    expect(fieldMaskParts(enterpriseDetailsFieldMask)).toStrictEqual(
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
    expect(enterpriseDetailsResponse.body.billingCategory).toBe(
      "places.details.enterprise",
    );
    expect(enterpriseDetailsResponse.body.creditsCharged).toBe(24);
    await expect(orgCredits(enterpriseDetailsFixture.orgId)).resolves.toBe(976);
  });
});

describe("BDD POST /api/zero/maps/* — auth + not-configured chain", () => {
  const track = createFixtureTracker(deleteMapsFixture);

  beforeEach(() => {
    mockEnv("ZERO_MAPS_GOOGLE_MAPS_TOKEN", GOOGLE_MAPS_KEY);
  });

  it("gwt-wt-wt: 403 zero token without maps:read → 503 platform key not configured", async () => {
    // Given: a seeded maps fixture + a zero token
    // with `file:read` (no maps:read capability).

    // When + Then: 403 — Missing required capability:
    // maps:read.
    const noCapFixture = await track(seedMapsFixture());
    const noCapToken = zeroToken(noCapFixture, ["file:read"]);

    const noCapResponse = await accept(
      apiClient().geocode({
        headers: { authorization: `Bearer ${noCapToken}` },
        body: { address: "1 Infinite Loop, Cupertino" },
      }),
      [403],
    );

    expect(noCapResponse.body.error.message).toBe(
      "Missing required capability: maps:read",
    );

    // Given: the platform key env var is unset + a
    // seeded maps fixture + an admin Clerk session.

    // When + Then: 503 — NOT_CONFIGURED.
    mockEnv("ZERO_MAPS_GOOGLE_MAPS_TOKEN", undefined);
    const noKeyFixture = await track(seedMapsFixture());
    mocks.clerk.session(noKeyFixture.userId, noKeyFixture.orgId, "org:admin");

    const noKeyResponse = await accept(
      apiClient().geocode({
        headers: authHeaders(),
        body: { address: "1 Infinite Loop, Cupertino" },
      }),
      [503],
    );

    expect(noKeyResponse.body.error.code).toBe("NOT_CONFIGURED");
  });
});
