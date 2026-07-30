import { command } from "ccstate";
import {
  authHeadersSchema,
  initContract,
} from "@vm0/api-contracts/contracts/base";
import { apiErrorSchema } from "@vm0/api-contracts/contracts/errors";
import { createRunResponseSchema } from "@vm0/api-contracts/contracts/runs";
import { zeroRunCreateBodySchema } from "@vm0/api-contracts/contracts/zero-runs";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { now } from "../external/time";
import type { RouteEntry } from "../route-entry";
import { ApiDispatchTimingCollector } from "../services/api-dispatch-timing.service";
import { createZeroRun$ } from "../services/zero-runs-create.service";

const c = initContract();

export const zeroRunFixtureContract = c.router({
  create: {
    method: "POST",
    path: "/api/test/zero-run-fixture",
    headers: authHeadersSchema,
    body: zeroRunCreateBodySchema,
    responses: {
      201: createRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      429: apiErrorSchema,
      503: apiErrorSchema,
    },
  },
});

const zeroRunFixtureBody$ = bodyResultOf(zeroRunFixtureContract.create);

const createZeroRunFixture$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const apiStartTime = now();
    const timing = new ApiDispatchTimingCollector();
    const body = await timing.measure(
      "api_dispatch_pre_create_zero_parse_body",
      "nested",
      async () => {
        return await get(zeroRunFixtureBody$);
      },
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const args = await timing.measure(
      "api_dispatch_pre_create_zero_prepare_args",
      "nested",
      () => {
        const auth = get(organizationAuthContext$);
        return { auth, body: body.data, apiStartTime, timing };
      },
    );
    signal.throwIfAborted();
    return await set(createZeroRun$, args, signal);
  },
);

/**
 * Test-only Zero run creation adapter. This route is intentionally omitted
 * from every production and E2E route registry.
 */
export const zeroRunFixtureRoutes: readonly RouteEntry[] = [
  {
    route: zeroRunFixtureContract.create,
    handler: authRoute(
      {
        accept: ["session", "pat"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      createZeroRunFixture$,
    ),
  },
];
