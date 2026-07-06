import { zeroSteamPlayerContract } from "@vm0/api-contracts/contracts/zero-steam-player";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import {
  isSteamUpstreamError,
  steamPlayerData$,
} from "../services/steam-player.service";
import { settle } from "../utils";

const connectorReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "connector:read",
} as const;

const getSteamPlayerInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const playerResult = await settle(
      set(steamPlayerData$, { orgId: auth.orgId, userId: auth.userId }, signal),
      signal,
    );
    if (!playerResult.ok) {
      if (!isSteamUpstreamError(playerResult.error)) {
        throw playerResult.error;
      }
      return createErrorResponse(
        "PROVIDER_UNAVAILABLE",
        "Steam API is temporarily unavailable",
      );
    }

    const player = playerResult.value;
    if (!player) {
      return createErrorResponse(
        "NOT_FOUND",
        "Steam connector is not connected",
      );
    }

    return {
      status: 200 as const,
      body: player,
    };
  },
);

export const zeroSteamPlayerRoutes: readonly RouteEntry[] = [
  {
    route: zeroSteamPlayerContract.getPlayer,
    handler: authRoute(connectorReadAuth, getSteamPlayerInner$),
  },
];
