import { initContract } from "@ts-rest/core";
import { computed } from "ccstate";
import { z } from "zod";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { AuthContext } from "../../types/auth";
import type { RouteEntry } from "../route";

const c = initContract();

const probeRoute = c.router({
  check: {
    method: "GET" as const,
    path: "/health/auth",
    headers: z.object({
      authorization: z.string().optional(),
      cookie: z.string().optional(),
    }),
    responses: {
      200: z.unknown(),
      401: z.object({
        error: z.object({ message: z.string(), code: z.string() }),
      }),
    },
    summary: "Resolve auth context for the current request",
  },
});

const returnAuthContext$ = computed(
  (get): { readonly status: 200; readonly body: AuthContext } => {
    return { status: 200 as const, body: get(authContext$) };
  },
);

const probe$ = authRoute(
  { acceptAnySandboxCapability: true },
  returnAuthContext$,
);

export const healthAuthProbeRoutes: readonly RouteEntry[] = [
  { route: probeRoute.check, handler: probe$ },
];

export const healthAuthProbeContract = probeRoute;
