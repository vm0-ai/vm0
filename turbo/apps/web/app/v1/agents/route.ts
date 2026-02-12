/**
 * Public API v1 - Agents Endpoints
 *
 * GET /v1/agents - List agents
 */
import { initServices } from "../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../src/lib/public-api/handler";
import { publicAgentsListContract } from "@vm0/core";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../src/lib/public-api/auth";
import { getUserScopeByClerkId } from "../../../src/lib/scope/scope-service";
import { getUserEmail } from "../../../src/lib/auth/get-user-email";
import { getEmailSharedAgents } from "../../../src/lib/agent/permission-service";
import { agentComposes } from "../../../src/db/schema/agent-compose";
import { eq, and, desc, gt } from "drizzle-orm";

const router = tsr.router(publicAgentsListContract, {
  list: async ({ query, headers }) => {
    initServices();

    const auth = await authenticatePublicApi(headers.authorization);
    if (!isAuthSuccess(auth)) {
      return {
        status: 401 as const,
        body: {
          error: {
            type: "authentication_error" as const,
            code: "invalid_api_key",
            message: "Invalid API key provided",
          },
        },
      };
    }

    // Get user's scope
    const userScope = await getUserScopeByClerkId(auth.userId);
    if (!userScope) {
      return {
        status: 401 as const,
        body: {
          error: {
            type: "authentication_error" as const,
            code: "invalid_api_key",
            message:
              "Please set up your scope first. Login again with: vm0 login",
          },
        },
      };
    }

    // Build query conditions for own agents
    const ownConditions = [eq(agentComposes.scopeId, userScope.id)];

    // Filter by name if provided (case-insensitive - normalize to lowercase)
    const nameFilter = query.name?.toLowerCase();
    if (nameFilter) {
      ownConditions.push(eq(agentComposes.name, nameFilter));
    }

    // Handle cursor-based pagination
    if (query.cursor) {
      ownConditions.push(gt(agentComposes.id, query.cursor));
    }

    const limit = query.limit ?? 20;

    // Fetch own agents
    const ownAgents = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(and(...ownConditions))
      .orderBy(desc(agentComposes.createdAt))
      .limit(limit + 1);

    // Fetch email-shared agents (small set, no cursor/limit needed)
    const userEmail = await getUserEmail(auth.userId);
    const sharedAgents = await getEmailSharedAgents(
      auth.userId,
      userEmail,
      nameFilter ? { nameFilter } : undefined,
    );

    // Combine own + shared, sort by createdAt desc
    const combined = [
      ...ownAgents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        currentVersionId: agent.headVersionId,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      })),
      ...sharedAgents.map((agent) => ({
        id: agent.id,
        name: `${agent.scopeSlug}/${agent.name}`,
        currentVersionId: agent.headVersionId,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Apply cursor filter in app code (shared agents weren't DB-filtered by cursor)
    const afterCursor = query.cursor
      ? combined.filter((agent) => agent.id > query.cursor!)
      : combined;

    // Apply limit + 1 pagination
    const hasMore = afterCursor.length > limit;
    const data = hasMore ? afterCursor.slice(0, limit) : afterCursor;
    const nextCursor =
      hasMore && data.length > 0 ? data[data.length - 1]!.id : null;

    return {
      status: 200 as const,
      body: {
        data: data.map((agent) => ({
          id: agent.id,
          name: agent.name,
          currentVersionId: agent.currentVersionId,
          createdAt: agent.createdAt.toISOString(),
          updatedAt: agent.updatedAt.toISOString(),
        })),
        pagination: {
          hasMore: hasMore,
          nextCursor: nextCursor,
        },
      },
    };
  },
});

const handler = createPublicApiHandler(publicAgentsListContract, router);

export { handler as GET };
