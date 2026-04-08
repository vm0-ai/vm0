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
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { serverSideCompose } from "../../../../src/lib/infra/compose/server-side-compose";
import { zeroAgents } from "../../../../src/db/schema/zero-agent";
import { agentComposes } from "../../../../src/db/schema/agent-compose";
import { eq, desc } from "drizzle-orm";
import { buildComposeContent } from "../../../../src/lib/zero/build-compose-content";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("api:zero-agents");

const router = tsr.router(zeroAgentsMainContract, {
  create: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    // Generate UUID agent name
    const agentName = crypto.randomUUID();

    const customSkills = body.customSkills ?? [];

    // Build compose content (always includes all connector skills)
    const content = buildComposeContent(
      agentName,
      customSkills.map((name) => {
        return { name };
      }),
    );

    // Run synchronous compose (pass empty instructions so the
    // agent-instructions storage record is created — without it,
    // schedule runs fail with "storage not found").
    const result = await serverSideCompose({
      userId,
      orgId: org.orgId,
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
        owner: userId,
        displayName: body.displayName ?? null,
        description: body.description ?? null,
        sound: body.sound ?? null,
        avatarUrl: body.avatarUrl ?? null,
        customSkills,
      })
      .onConflictDoUpdate({
        target: [zeroAgents.orgId, zeroAgents.name],
        set: {
          displayName: body.displayName ?? null,
          description: body.description ?? null,
          sound: body.sound ?? null,
          avatarUrl: body.avatarUrl ?? null,
          customSkills,
          updatedAt: new Date(),
        },
      });

    log.info(`Created zero agent: ${result.composeName}`);

    return {
      status: 201 as const,
      body: {
        agentId: result.composeId,
        ownerId: userId,
        description: body.description ?? null,
        displayName: body.displayName ?? null,
        sound: body.sound ?? null,
        avatarUrl: body.avatarUrl ?? null,
        permissionPolicies: null,
        customSkills,
      },
    };
  },

  list: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    const rows = await globalThis.services.db
      .select({
        agentId: zeroAgents.id,
        owner: zeroAgents.owner,
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
        avatarUrl: zeroAgents.avatarUrl,
        permissionPolicies: zeroAgents.permissionPolicies,
        customSkills: zeroAgents.customSkills,
      })
      .from(zeroAgents)
      .innerJoin(agentComposes, eq(zeroAgents.id, agentComposes.id))
      .where(eq(zeroAgents.orgId, org.orgId))
      .orderBy(desc(zeroAgents.updatedAt));

    return {
      status: 200 as const,
      body: rows.map((row) => {
        return {
          agentId: row.agentId,
          ownerId: row.owner,
          displayName: row.displayName ?? null,
          description: row.description ?? null,
          sound: row.sound ?? null,
          avatarUrl: row.avatarUrl ?? null,
          permissionPolicies: row.permissionPolicies ?? null,
          customSkills: row.customSkills,
        };
      }),
    };
  },
});

const handler = createHandler(zeroAgentsMainContract, router, {
  errorHandler: createSafeErrorHandler("zero-agents"),
});

export { handler as POST, handler as GET };
