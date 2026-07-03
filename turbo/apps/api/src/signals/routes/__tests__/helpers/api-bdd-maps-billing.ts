import { onboardingSetupContract } from "@vm0/api-contracts/contracts/onboarding";
import {
  zeroBillingStatusContract,
  type BillingStatusResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import { zeroMapsContract } from "@vm0/api-contracts/contracts/zero-maps";

import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { mockEnv } from "../../../../lib/env";
import type { RouteEntry } from "../../../route-entry";
import { zeroOnboardingSetupRoutes } from "../../zero-onboarding-setup";
import { zeroBillingStatusRoutes } from "../../zero-billing-status";
import { zeroMapsRoutes } from "../../zero-maps";
import type { ApiTestUser, OnboardingSetupBody } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

type MapsStatus = 200 | 400 | 401 | 402 | 403 | 502 | 503;
type OsmLayer = "roads" | "buildings" | "water" | "parks";
type OsmStyle = "standard" | "guide";

interface AuthHeaders {
  readonly authorization?: string;
}

interface OsmAreaBody {
  readonly bbox?: {
    readonly west: number;
    readonly south: number;
    readonly east: number;
    readonly north: number;
  };
  readonly center?: {
    readonly lat: number;
    readonly lng: number;
  };
  readonly radiusMeters?: number;
  readonly layers?: readonly OsmLayer[];
}

interface OsmRenderBody extends OsmAreaBody {
  readonly width?: number;
  readonly height?: number;
  readonly style?: OsmStyle;
  readonly title?: string;
  readonly markers?: readonly {
    readonly lat: number;
    readonly lng: number;
    readonly label?: string;
  }[];
}

const mapsBillingRoutes: readonly RouteEntry[] = [
  ...zeroOnboardingSetupRoutes,
  ...zeroBillingStatusRoutes,
  ...zeroMapsRoutes,
];

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function authenticate(context: TestContext, actor: ApiTestUser | null) {
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }

  createZeroRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return authHeaders(actor);
}

function mapsBillingApp(context: TestContext) {
  return setupAppWithRoutes({ context, routes: mapsBillingRoutes });
}

export function createMapsBillingApi(context: TestContext) {
  return {
    configureMapsProvider(): void {
      mockEnv("ZERO_MAPS_GOOGLE_MAPS_TOKEN", "test-google-maps-key");
    },

    async setupOnboarding(actor: ApiTestUser, body: OnboardingSetupBody) {
      const client = mapsBillingApp(context)(onboardingSetupContract);
      return await accept(
        client.setup({ headers: authenticate(context, actor), body }),
        [200, 409],
      );
    },

    async readBillingStatus(
      actor: ApiTestUser,
    ): Promise<BillingStatusResponse> {
      const client = mapsBillingApp(context)(zeroBillingStatusContract);
      const response = await accept(
        client.get({ headers: authenticate(context, actor) }),
        [200],
      );
      return response.body;
    },

    async requestMapsGeocode(
      actor: ApiTestUser | null,
      body: { readonly address: string; readonly region?: string },
      statuses: readonly MapsStatus[],
    ) {
      const client = mapsBillingApp(context)(zeroMapsContract);
      return await accept(
        client.geocode({ headers: authenticate(context, actor), body }),
        statuses,
      );
    },

    async requestMapsReverseGeocode(
      actor: ApiTestUser | null,
      body: { readonly lat: number; readonly lng: number },
      statuses: readonly MapsStatus[],
    ) {
      const client = mapsBillingApp(context)(zeroMapsContract);
      return await accept(
        client.reverseGeocode({ headers: authenticate(context, actor), body }),
        statuses,
      );
    },

    async requestMapsDirections(
      actor: ApiTestUser | null,
      body: {
        readonly origin: string;
        readonly destination: string;
        readonly mode?: "driving" | "walking" | "bicycling" | "transit";
        readonly departureTime?: string;
      },
      statuses: readonly MapsStatus[],
    ) {
      const client = mapsBillingApp(context)(zeroMapsContract);
      return await accept(
        client.directions({ headers: authenticate(context, actor), body }),
        statuses,
      );
    },

    async requestMapsPlacesSearch(
      actor: ApiTestUser | null,
      body: {
        readonly query: string;
        readonly location?: string;
        readonly radius?: number;
        readonly limit?: number;
        readonly region?: string;
        readonly fields?: "pro" | "enterprise";
      },
      statuses: readonly MapsStatus[],
    ) {
      const client = mapsBillingApp(context)(zeroMapsContract);
      return await accept(
        client.placesSearch({ headers: authenticate(context, actor), body }),
        statuses,
      );
    },

    async requestMapsPlacesDetails(
      actor: ApiTestUser | null,
      body: {
        readonly placeId: string;
        readonly fields?: "essentials" | "pro" | "enterprise";
      },
      statuses: readonly MapsStatus[],
    ) {
      const client = mapsBillingApp(context)(zeroMapsContract);
      return await accept(
        client.placesDetails({ headers: authenticate(context, actor), body }),
        statuses,
      );
    },

    async requestMapsOsmDownload(
      actor: ApiTestUser | null,
      body: OsmAreaBody,
      statuses: readonly MapsStatus[],
    ) {
      const client = mapsBillingApp(context)(zeroMapsContract);
      return await accept(
        client.osmDownload({ headers: authenticate(context, actor), body }),
        statuses,
      );
    },

    async requestMapsOsmRender(
      actor: ApiTestUser | null,
      body: OsmRenderBody,
      statuses: readonly MapsStatus[],
    ) {
      const client = mapsBillingApp(context)(zeroMapsContract);
      return await accept(
        client.osmRender({ headers: authenticate(context, actor), body }),
        statuses,
      );
    },
  };
}
