import { command } from "ccstate";
import { zeroMorningBriefContract } from "@vm0/api-contracts/contracts/zero-morning-brief";

import { badRequestMessage } from "../../lib/error";
import { now } from "../external/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import { triggerMorningBriefNow$ } from "../services/morning-brief-run.service";

const triggerMorningBriefInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const result = await set(
      triggerMorningBriefNow$,
      { orgId: auth.orgId, userId: auth.userId, apiStartTime: now() },
      signal,
    );

    if (result.kind === "forbidden") {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "Manual morning brief is not enabled",
            code: "FORBIDDEN",
          },
        },
      };
    }
    if (result.kind === "bad_request") {
      return badRequestMessage(result.message);
    }

    return {
      status: 200 as const,
      body: { runId: result.runId, briefDate: result.briefDate },
    };
  },
);

export const zeroMorningBriefRoutes: readonly RouteEntry[] = [
  {
    route: zeroMorningBriefContract.trigger,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      triggerMorningBriefInner$,
    ),
  },
];
