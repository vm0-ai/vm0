import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { onboardingStatusContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { isBadRequest, isNotFound } from "../../../../src/lib/errors";
import { modelProviders } from "../../../../src/db/schema/model-provider";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { eq } from "drizzle-orm";
import { agentComposeApiContentSchema } from "@vm0/core";
import { auth } from "@clerk/nextjs/server";

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

    // Check if org exists
    let hasOrg = false;
    let hasModelProvider = false;
    let hasDefaultAgent = false;
    let defaultAgentName: string | null = null;
    let defaultAgentComposeId: string | null = null;
    let defaultAgentMetadata: {
      displayName?: string;
      description?: string;
      sound?: string;
    } | null = null;

    try {
      const { org: resolvedOrg } = await resolveOrg(userId);
      hasOrg = true;

      // Check model provider
      const [provider] = await globalThis.services.db
        .select({ id: modelProviders.id })
        .from(modelProviders)
        .where(eq(modelProviders.orgId, resolvedOrg.orgId))
        .limit(1);

      hasModelProvider = provider !== undefined;

      // Read default agent compose ID from Clerk JWT session claims
      const authResult = await auth();
      const claimAgentComposeId =
        authResult.sessionClaims?.org_default_agent_compose_id ?? null;

      if (claimAgentComposeId) {
        const [compose] = await globalThis.services.db
          .select({
            name: agentComposes.name,
            headVersionId: agentComposes.headVersionId,
            content: agentComposeVersions.content,
          })
          .from(agentComposes)
          .leftJoin(
            agentComposeVersions,
            eq(agentComposes.headVersionId, agentComposeVersions.id),
          )
          .where(eq(agentComposes.id, claimAgentComposeId))
          .limit(1);

        if (compose) {
          hasDefaultAgent = true;
          defaultAgentName = compose.name;
          defaultAgentComposeId = claimAgentComposeId;

          // Extract metadata from compose content
          const parsed = agentComposeApiContentSchema.safeParse(
            compose.content,
          );
          if (parsed.success) {
            const agentKey = Object.keys(parsed.data.agents)[0];
            const agentDef = agentKey
              ? parsed.data.agents[agentKey]
              : undefined;
            if (agentDef) {
              defaultAgentMetadata = agentDef.metadata ?? null;
            }
          }
        }
      }
    } catch (error) {
      if (!isNotFound(error) && !isBadRequest(error)) {
        throw error;
      }
      // Org not found or no explicit org context — all flags stay false
    }

    const needsOnboarding = !hasOrg || !hasModelProvider || !hasDefaultAgent;

    return {
      status: 200 as const,
      body: {
        needsOnboarding,
        hasOrg,
        hasModelProvider,
        hasDefaultAgent,
        defaultAgentName,
        defaultAgentComposeId,
        defaultAgentMetadata,
      },
    };
  },
});

const handler = createHandler(onboardingStatusContract, router);

export { handler as GET };
