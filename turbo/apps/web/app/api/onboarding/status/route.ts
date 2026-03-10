import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { onboardingStatusContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { resolveScope } from "../../../../src/lib/scope/resolve-scope";
import { isNotFound } from "../../../../src/lib/errors";
import { modelProviders } from "../../../../src/db/schema/model-provider";
import { agentComposes } from "../../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";

const router = tsr.router(onboardingStatusContract, {
  getStatus: async ({ headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    // Check if scope exists
    let hasScope = false;
    let hasModelProvider = false;
    let hasDefaultAgent = false;
    let defaultAgentName: string | null = null;
    let defaultAgentComposeId: string | null = null;

    try {
      const { scope } = await resolveScope(userId);
      hasScope = true;

      // Check model provider
      const [provider] = await globalThis.services.db
        .select({ id: modelProviders.id })
        .from(modelProviders)
        .where(eq(modelProviders.clerkOrgId, scope.clerkOrgId))
        .limit(1);

      hasModelProvider = provider !== undefined;

      // Check default agent and get its name
      if (scope.defaultAgentComposeId) {
        const [compose] = await globalThis.services.db
          .select({ name: agentComposes.name })
          .from(agentComposes)
          .where(eq(agentComposes.id, scope.defaultAgentComposeId))
          .limit(1);

        if (compose) {
          hasDefaultAgent = true;
          defaultAgentName = compose.name;
          defaultAgentComposeId = scope.defaultAgentComposeId;
        }
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      // Scope not found — all flags stay false
    }

    const needsOnboarding = !hasScope || !hasModelProvider || !hasDefaultAgent;

    return {
      status: 200 as const,
      body: {
        needsOnboarding,
        hasScope,
        hasModelProvider,
        hasDefaultAgent,
        defaultAgentName,
        defaultAgentComposeId,
      },
    };
  },
});

const handler = createHandler(onboardingStatusContract, router);

export { handler as GET };
