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
import { eq, desc } from "drizzle-orm";
import { buildComposeContent } from "../../../../src/lib/zero/build-compose-content";
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

    // Build compose content (always includes all connector skills)
    const content = buildComposeContent(agentName);

    // Run synchronous compose (pass empty instructions so the
    // agent-instructions storage record is created — without it,
    // schedule runs fail with "storage not found").
    const result = await serverSideCompose({
      userId,
      orgId: org.orgId,
      orgSlug: org.slug,
      content,
      instructions: "",
    });

    if (!result) {
      return {
        status: 422 as const,
        body: {
          error: {
            message:
              "One or more skills are not cached. Please try again later.",
            code: "UNPROCESSABLE_ENTITY",
          },
        },
      };
    }

    // Write metadata to zero_agents (PK = composeId)
    await globalThis.services.db
      .insert(zeroAgents)
      .values({
        id: result.composeId,
        orgId: org.orgId,
        name: result.composeName,
        displayName: body.displayName ?? null,
        description: body.description ?? null,
        sound: body.sound ?? null,
        avatarUrl: body.avatarUrl ?? null,
      })
      .onConflictDoUpdate({
        target: [zeroAgents.orgId, zeroAgents.name],
        set: {
          displayName: body.displayName ?? null,
          description: body.description ?? null,
          sound: body.sound ?? null,
          avatarUrl: body.avatarUrl ?? null,
          updatedAt: new Date(),
        },
      });

    log.info(`Created zero agent: ${result.composeName}`);

    return {
      status: 201 as const,
      body: {
        agentId: result.composeId,
        description: body.description ?? null,
        displayName: body.displayName ?? null,
        sound: body.sound ?? null,
        avatarUrl: body.avatarUrl ?? null,
        firewallPolicies: null,
        customSkills: [],
      },
    };
  },

  list: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authCtx)) return authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    const rows = await globalThis.services.db
      .select({
        agentId: zeroAgents.id,
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
        avatarUrl: zeroAgents.avatarUrl,
        firewallPolicies: zeroAgents.firewallPolicies,
        customSkills: zeroAgents.customSkills,
      })
      .from(zeroAgents)
      .where(eq(zeroAgents.orgId, org.orgId))
      .orderBy(desc(zeroAgents.updatedAt));

    return {
      status: 200 as const,
      body: rows.map((row) => ({
        agentId: row.agentId,
        displayName: row.displayName ?? null,
        description: row.description ?? null,
        sound: row.sound ?? null,
        avatarUrl: row.avatarUrl ?? null,
        firewallPolicies: row.firewallPolicies ?? null,
        customSkills: row.customSkills,
      })),
    };
  },
});

const handler = createHandler(zeroAgentsMainContract, router, {
  errorHandler: createSafeErrorHandler("zero-agents"),
});

export { handler as POST, handler as GET };
