import { command } from "ccstate";
import { zeroBuiltInGenerationContract } from "@vm0/api-contracts/contracts/zero-built-in-generation";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route";
import { getBuiltInGenerationJob$ } from "../services/zero-built-in-generation.service";

const builtInGenerationNotFound = notFound("Built-in generation not found");

const generationPathParams$ = pathParamsOf(zeroBuiltInGenerationContract.get);

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

export const zeroBuiltInGenerationRoutes: readonly RouteEntry[] = [
  {
    route: zeroBuiltInGenerationContract.get,
    handler: authRoute(
      {
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      getBuiltInGenerationInner$,
    ),
  },
];
