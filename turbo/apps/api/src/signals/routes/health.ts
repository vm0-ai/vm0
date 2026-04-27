import { computed } from "ccstate";
import { type HealthRouteResponse } from "@vm0/api-contracts/contracts";

export const apiHealth$ = computed<Promise<HealthRouteResponse>>(async () => {
  await Promise.resolve();
  return { status: 200, body: { status: "ok" } };
});
