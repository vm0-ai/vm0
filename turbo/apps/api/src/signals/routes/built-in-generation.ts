import { command } from "ccstate";
import { builtInGenerationContract } from "@okouai/api-contracts/contracts/built-in-generation";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";
import { getBuiltInGenerationJob$ } from "../services/built-in-generation.service";

const builtInGenerationNotFound = notFound("Built-in generation not found");

const generationPathParams$ = pathParamsOf(builtInGenerationContract.get);

const getBuiltInGenerationInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(generationPathParams$);
    const job = await set(
      getBuiltInGenerationJob$,
      { generationId: params.generationId, orgId: auth.orgId },
      signal,
    );
    if (!job) {
      return builtInGenerationNotFound;
    }
    return { status: 200 as const, body: job };
  },
);

export const builtInGenerationRoutes: readonly RouteEntry[] = [
  {
    route: builtInGenerationContract.get,
    handler: authRoute(
      {
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      getBuiltInGenerationInner$,
    ),
  },
];
