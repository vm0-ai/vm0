import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import { zeroAgentsMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { serverSideCompose } from "../../../../src/lib/compose/server-side-compose";
import { zeroAgents } from "../../../../src/db/schema/zero-agent";
import {
  buildComposeContent,
  extractConnectors,
} from "../../../../src/lib/zero/build-compose-content";
import { logger } from "../../../../src/lib/logger";

const log = logger("api:zero-agents");

const router = tsr.router(zeroAgentsMainContract, {
  create: async ({ body, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    // Generate UUID agent name
    const agentName = crypto.randomUUID();

    // Build compose content from connectors
    const content = buildComposeContent(agentName, body.connectors);

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

    log.info(`Created zero agent: ${result.composeName}`);

    return {
      status: 201 as const,
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

const handler = createHandler(zeroAgentsMainContract, router, {
  errorHandler: createSafeErrorHandler("zero-agents"),
});

export { handler as POST };
