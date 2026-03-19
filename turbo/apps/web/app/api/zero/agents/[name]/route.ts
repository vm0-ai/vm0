import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroAgentsByNameContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { serverSideCompose } from "../../../../../src/lib/compose/server-side-compose";
import { zeroAgents } from "../../../../../src/db/schema/zero-agent";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../src/db/schema/agent-compose";
import { eq, and } from "drizzle-orm";
import {
  buildComposeContent,
  extractConnectors,
} from "../../../../../src/lib/zero/build-compose-content";
import { logger } from "../../../../../src/lib/logger";

const log = logger("api:zero-agents:name");

const router = tsr.router(zeroAgentsByNameContract, {
  get: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    // Look up compose by name + org
    const [compose] = await globalThis.services.db
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
        content: agentComposeVersions.content,
      })
      .from(agentComposes)
      .leftJoin(
        agentComposeVersions,
        eq(agentComposes.headVersionId, agentComposeVersions.id),
      )
      .where(
        and(
          eq(agentComposes.orgId, org.orgId),
          eq(agentComposes.name, params.name),
        ),
      )
      .limit(1);

    if (!compose) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent not found: ${params.name}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Look up zero_agent metadata
    const [agent] = await globalThis.services.db
      .select()
      .from(zeroAgents)
      .where(
        and(eq(zeroAgents.orgId, org.orgId), eq(zeroAgents.name, params.name)),
      )
      .limit(1);

    // Extract connector short names from compose content
    const content = (compose.content ?? {}) as Record<string, unknown>;
    const connectors = extractConnectors(content);

    return {
      status: 200 as const,
      body: {
        name: compose.name,
        agentComposeId: compose.id,
        description: agent?.description ?? null,
        displayName: agent?.displayName ?? null,
        sound: agent?.sound ?? null,
        connectors,
      },
    };
  },

  update: async ({ params, body, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    // Verify agent exists
    const [existing] = await globalThis.services.db
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.orgId, org.orgId),
          eq(agentComposes.name, params.name),
        ),
      )
      .limit(1);

    if (!existing) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent not found: ${params.name}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Build compose content from connectors
    const content = buildComposeContent(params.name, body.connectors);

    // Run synchronous compose
    const result = await serverSideCompose({
      userId,
      orgId: org.orgId,
      orgSlug: org.slug,
      content,
    });

    if (!result) {
      return {
        status: 422 as const,
        body: {
          error: {
            message:
              "One or more connectors reference skills that are not cached. Please try again later.",
            code: "UNPROCESSABLE_ENTITY",
          },
        },
      };
    }

    // Write metadata to zero_agents
    await globalThis.services.db
      .insert(zeroAgents)
      .values({
        orgId: org.orgId,
        name: result.composeName,
        displayName: body.displayName ?? null,
        description: body.description ?? null,
        sound: body.sound ?? null,
      })
      .onConflictDoUpdate({
        target: [zeroAgents.orgId, zeroAgents.name],
        set: {
          displayName: body.displayName ?? null,
          description: body.description ?? null,
          sound: body.sound ?? null,
          updatedAt: new Date(),
        },
      });

    log.info(`Updated zero agent: ${result.composeName}`);

    return {
      status: 200 as const,
      body: {
        name: result.composeName,
        agentComposeId: result.composeId,
        description: body.description ?? null,
        displayName: body.displayName ?? null,
        sound: body.sound ?? null,
        connectors: extractConnectors(content),
      },
    };
  },
});

const handler = createHandler(zeroAgentsByNameContract, router, {
  errorHandler: createSafeErrorHandler("zero-agents:name"),
});

export { handler as GET, handler as PUT };
