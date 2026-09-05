import { command } from "ccstate";
import {
  authHeadersSchema,
  initContract,
} from "@okouai/api-contracts/contracts/base";
import { apiErrorSchema } from "@okouai/api-contracts/contracts/errors";
import { createRunResponseSchema } from "@okouai/api-contracts/contracts/runs";
import { runCreateBodySchema } from "@okouai/api-contracts/contracts/run-routes";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { publicBrand$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { now } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import { ApiDispatchTimingCollector } from "../services/api-dispatch-timing.service";
import { createTestFixtureAgentRun$ } from "../services/agent-runs-create.service";

const c = initContract();

export const runFixtureContract = c.router({
  create: {
    method: "POST",
    path: "/api/test/zero-run-fixture",
    headers: authHeadersSchema,
    body: runCreateBodySchema,
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

const agentRunFixtureBody$ = bodyResultOf(runFixtureContract.create);

const createAgentRunFixture$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const apiStartTime = now();
    const timing = new ApiDispatchTimingCollector();
    const body = await timing.measure(
      "api_dispatch_pre_create_zero_parse_body",
      "nested",
      async () => {
        return await get(agentRunFixtureBody$);
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
        return {
          auth,
          body: body.data,
          apiStartTime,
          publicBrand: get(publicBrand$),
          piExecution: false,
          timing,
        };
      },
    );
    signal.throwIfAborted();
    return await set(createTestFixtureAgentRun$, args, signal);
  },
);

/**
 * Test-only agent run creation adapter. This route is intentionally omitted
 * from every production and E2E route registry.
 */
export const runFixtureRoutes: readonly RouteEntry[] = [
  {
    route: runFixtureContract.create,
    handler: authRoute(
      {
        accept: ["session", "pat"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      createAgentRunFixture$,
    ),
  },
];
