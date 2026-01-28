import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { runnerRealtimeTokenContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getRunnerAuth } from "../../../../../src/lib/auth/runner-auth";
import { generateRunnerGroupToken } from "../../../../../src/lib/realtime/client";
import {
  validateRunnerGroupScope,
  isOfficialRunnerGroup,
} from "../../../../../src/lib/scope/scope-service";
import { logger } from "../../../../../src/lib/logger";

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
      // User runners: validate scope
      try {
        await validateRunnerGroupScope(auth.userId, group);
      } catch (error) {
        return createErrorResponse(
          "FORBIDDEN",
          error instanceof Error ? error.message : "Scope validation failed",
        );
      }
      log.debug(`User runner ${auth.userId} requesting token for ${group}`);
    }

    // Generate Ably token for this runner group's channel
    const tokenRequest = await generateRunnerGroupToken(group);

    if (!tokenRequest) {
      return createErrorResponse(
        "INTERNAL_SERVER_ERROR",
        "Realtime service unavailable",
      );
    }

    return {
      status: 200 as const,
      body: tokenRequest,
    };
  },
});

const handler = createHandler(runnerRealtimeTokenContract, router);

export { handler as POST };
