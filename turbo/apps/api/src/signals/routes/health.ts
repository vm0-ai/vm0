import { computed } from "ccstate";
import {
  type HealthAuthRouteResponse,
  type HealthRouteResponse,
} from "@vm0/api-contracts/contracts";

import { authRoute } from "../auth/auth-route";

export const apiHealth$ = computed<Promise<HealthRouteResponse>>(async () => {
  await Promise.resolve();
  return { status: 200, body: { status: "ok" } };
});

export const apiHealthAuth$ = authRoute(
  {},
  computed((): HealthAuthRouteResponse => {
    return { status: 200 as const, body: { status: "ok" } };
  }),
);
