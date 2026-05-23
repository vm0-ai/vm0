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
import { beforeEach } from "vitest";

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
  ["places.details.essentials", 6],
  ["places.details.pro", 21],
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

describe("POST /api/zero/maps/*", () => {
  const track = createFixtureTracker(deleteMapsFixture);

  beforeEach(() => {
    mockEnv("ZERO_MAPS_GOOGLE_MAPS_TOKEN", GOOGLE_MAPS_KEY);
  });

  it("geocodes through Google Maps and charges the marked-up geocoding price", async () => {
    const fixture = await track(seedMapsFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    let requestedUrl: URL | undefined;
    server.use(
      http.get(GOOGLE_GEOCODING_URL, ({ request }) => {
        requestedUrl = new URL(request.url);
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

    const client = setupApp({ context })(zeroMapsContract);
    const response = await accept(
      client.geocode({
        headers: authHeaders(),
        body: { address: "1 Infinite Loop, Cupertino", region: "US" },
      }),
      [200],
    );

    expect(requestedUrl?.searchParams.get("key")).toBe(GOOGLE_MAPS_KEY);
    expect(requestedUrl?.searchParams.get("address")).toBe(
      "1 Infinite Loop, Cupertino",
    );
    expect(requestedUrl?.searchParams.get("region")).toBe("US");
    expect(response.body).toMatchObject({
      operation: "geocode",
      provider: "google-maps",
      billingCategory: "geocoding",
      billingQuantity: 1,
      creditsCharged: 6,
    });
    await expect(orgCredits(fixture.orgId)).resolves.toBe(994);
  });

  it("charges the advanced directions price when departure time is requested", async () => {
    const fixture = await track(seedMapsFixture());
    let requestedUrl: URL | undefined;
    server.use(
      http.get(GOOGLE_DIRECTIONS_URL, ({ request }) => {
        requestedUrl = new URL(request.url);
        return HttpResponse.json({
          status: "OK",
          routes: [{ legs: [], overview_polyline: { points: "encoded" } }],
        });
      }),
    );

    const token = zeroToken(fixture, ["maps:read"]);
    const client = setupApp({ context })(zeroMapsContract);
    const response = await accept(
      client.directions({
        headers: { authorization: `Bearer ${token}` },
        body: {
          origin: "SFO",
          destination: "Mountain View",
          mode: "driving",
          departureTime: "now",
        },
      }),
      [200],
    );

    expect(requestedUrl?.searchParams.get("departure_time")).toBe("now");
    expect(response.body.billingCategory).toBe("routes.directions.advanced");
    expect(response.body.creditsCharged).toBe(12);
  });

  it("searches places with the Pro field mask and charges the marked-up text search price", async () => {
    const fixture = await track(seedMapsFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    let requestBody: unknown;
    let fieldMask: string | null = null;
    server.use(
      http.post(GOOGLE_PLACES_SEARCH_TEXT_URL, async ({ request }) => {
        fieldMask = request.headers.get("x-goog-fieldmask");
        requestBody = await request.json();
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

    const client = setupApp({ context })(zeroMapsContract);
    const response = await accept(
      client.placesSearch({
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

    expect(fieldMask).toContain("places.displayName");
    expect(requestBody).toStrictEqual({
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
    expect(response.body.billingCategory).toBe("places.text_search.pro");
    expect(response.body.creditsCharged).toBe(39);
  });

  it("rejects requests below the operation price before calling Google Maps", async () => {
    const fixture = await track(seedMapsFixture(6));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    let googleCalled = false;
    server.use(
      http.post(GOOGLE_PLACES_SEARCH_TEXT_URL, () => {
        googleCalled = true;
        return HttpResponse.json({ places: [] });
      }),
    );

    const client = setupApp({ context })(zeroMapsContract);
    const response = await accept(
      client.placesSearch({
        headers: authHeaders(),
        body: { query: "coffee", limit: 5 },
      }),
      [402],
    );

    expect(googleCalled).toBeFalsy();
    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
    await expect(orgCredits(fixture.orgId)).resolves.toBe(6);
  });

  it("fetches Pro place details and charges the marked-up details price", async () => {
    const fixture = await track(seedMapsFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    let fieldMask: string | null = null;
    server.use(
      http.get(GOOGLE_PLACE_DETAILS_URL, ({ request }) => {
        fieldMask = request.headers.get("x-goog-fieldmask");
        return HttpResponse.json({
          id: "ChIJtest",
          displayName: { text: "Coffee" },
          formattedAddress: "1 Market St, San Francisco, CA",
        });
      }),
    );

    const client = setupApp({ context })(zeroMapsContract);
    const response = await accept(
      client.placesDetails({
        headers: authHeaders(),
        body: { placeId: "places/ChIJtest", fields: "pro" },
      }),
      [200],
    );

    expect(fieldMask).toContain("displayName");
    expect(response.body.billingCategory).toBe("places.details.pro");
    expect(response.body.creditsCharged).toBe(21);
  });

  it("rejects zero tokens without maps:read before calling Google Maps", async () => {
    const fixture = await track(seedMapsFixture());
    const token = zeroToken(fixture, ["file:read"]);

    const client = setupApp({ context })(zeroMapsContract);
    const response = await accept(
      client.geocode({
        headers: { authorization: `Bearer ${token}` },
        body: { address: "1 Infinite Loop, Cupertino" },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "Missing required capability: maps:read",
    );
  });

  it("returns 503 when the platform Google Maps key is not configured", async () => {
    mockEnv("ZERO_MAPS_GOOGLE_MAPS_TOKEN", undefined);
    const fixture = await track(seedMapsFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroMapsContract);
    const response = await accept(
      client.geocode({
        headers: authHeaders(),
        body: { address: "1 Infinite Loop, Cupertino" },
      }),
      [503],
    );

    expect(response.body.error.code).toBe("NOT_CONFIGURED");
  });
});
