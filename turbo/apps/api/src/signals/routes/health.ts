import { computed } from "ccstate";
import {
  type HealthAuthRouteResponse,
  type HealthRouteResponse,
} from "@vm0/api-contracts/contracts";

import { createAuthContext$ } from "../auth/auth-context";
import { request$ } from "../context/hono";

export const apiHealth$ = computed<Promise<HealthRouteResponse>>(async () => {
  await Promise.resolve();
  return { status: 200, body: { status: "ok" } };
});

export const apiHealthAuth$ = computed(
  async (get): Promise<HealthAuthRouteResponse> => {
    const request = get(request$);
    const hasCredentials =
      request.header("authorization") || request.header("cookie");

    if (!hasCredentials) {
      return {
        status: 401,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    const authContext = await get(createAuthContext$());
    if (!authContext) {
      return {
        status: 401,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    return { status: 200, body: { status: "ok" } };
  },
);
