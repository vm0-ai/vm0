import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { runnerRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";
import { initServices } from "../../../../../src/lib/init-services";
import { getRunnerAuth } from "../../../../../src/lib/auth/runner-auth";
import { generateRunnerGroupToken } from "../../../../../src/lib/infra/realtime/client";
import { isOfficialRunnerGroup } from "../../../../../src/lib/infra/run/runner-group";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("api:runners:realtime:token");

const router = tsr.router(runnerRealtimeTokenContract, {
  create: async ({ body, headers }) => {
    initServices();

    const auth = await getRunnerAuth(headers.authorization);
    if (!auth) {
      return createErrorResponse("UNAUTHORIZED", "Authentication required");
    }

    const { group } = body;

    // Authorization based on auth type
    if (auth.type === "official-runner") {
      // Official runners can only subscribe to official runner groups (vm0/*)
      if (!isOfficialRunnerGroup(group)) {
        return createErrorResponse(
          "FORBIDDEN",
          "Official runners can only subscribe to vm0/* groups",
        );
      }
      log.debug(`Official runner requesting token for ${group}`);
    } else {
      // User runners: enforce vm0/* groups
      if (!isOfficialRunnerGroup(group)) {
        return createErrorResponse(
          "FORBIDDEN",
          "Only vm0/* runner groups are supported",
        );
      }
      log.debug(`User runner ${auth.userId} requesting token for ${group}`);
    }

    // Generate Ably token for this runner group's channel
    const tokenRequest = await generateRunnerGroupToken(group);

    return {
      status: 200 as const,
      body: tokenRequest,
    };
  },
});

const handler = createHandler(runnerRealtimeTokenContract, router, {
  routeName: "runners.realtime.token",
});

export { handler as POST };
