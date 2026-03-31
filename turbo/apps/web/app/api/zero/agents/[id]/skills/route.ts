import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../../src/lib/ts-rest-handler";
import { zeroAgentSkillsCollectionContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";
import { serverSideCompose } from "../../../../../../src/lib/compose/server-side-compose";
import { zeroAgents } from "../../../../../../src/db/schema/zero-agent";
import { zeroSkills } from "../../../../../../src/db/schema/zero-skill";
import { agentComposes } from "../../../../../../src/db/schema/agent-compose";
import { eq, and, inArray } from "drizzle-orm";
import { buildComposeContent } from "../../../../../../src/lib/zero/build-compose-content";
import { requireAdminForDefaultAgent } from "../../../../../../src/lib/zero/require-admin";
import { uploadSkillServerSide } from "../../../../../../src/lib/storage/skill-upload";
import { SEED_SKILLS } from "../../../../../../src/lib/zero/seed-skills";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("api:zero-agents:skills");

const router = tsr.router(zeroAgentSkillsCollectionContract, {
  list: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authCtx)) return authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    // Look up agent
    const [agent] = await globalThis.services.db
      .select()
      .from(zeroAgents)
      .where(and(eq(zeroAgents.orgId, org.orgId), eq(zeroAgents.id, params.id)))
      .limit(1);

    if (!agent) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent not found: ${params.id}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    const skillNames = agent.customSkills;
    if (skillNames.length === 0) {
      return { status: 200 as const, body: [] };
    }

    // Join with zero_skills for metadata
    const rows = await globalThis.services.db
      .select({
        name: zeroSkills.name,
        displayName: zeroSkills.displayName,
        description: zeroSkills.description,
      })
      .from(zeroSkills)
      .where(
        and(
          eq(zeroSkills.orgId, org.orgId),
          inArray(zeroSkills.name, skillNames),
        ),
      );

    return {
      status: 200 as const,
      body: rows.map((r) => ({
        name: r.name,
        displayName: r.displayName ?? null,
        description: r.description ?? null,
      })),
    };
  },

  create: async ({ params, body, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org, member } = await resolveOrg(authCtx, orgSlug);

    // Look up agent + compose name (need compose name for serverSideCompose)
    const [existing] = await globalThis.services.db
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
        customSkills: zeroAgents.customSkills,
        connectors: zeroAgents.connectors,
      })
      .from(agentComposes)
      .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .where(
        and(
          eq(agentComposes.orgId, org.orgId),
          eq(agentComposes.id, params.id),
        ),
      )
      .limit(1);

    if (!existing) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Agent not found: ${params.id}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Only admins can modify the default agent's skills
    const forbidden = await requireAdminForDefaultAgent(
      org.orgId,
      existing.id,
      member.role,
      "skills",
    );
    if (forbidden) return forbidden;

    // Validate name not in seed skills
    const seedSet = new Set<string>(SEED_SKILLS);
    if (seedSet.has(body.name)) {
      return {
        status: 409 as const,
        body: {
          error: {
            message: `Skill name "${body.name}" conflicts with a built-in skill`,
            code: "CONFLICT",
          },
        },
      };
    }

    // Check uniqueness in zero_skills
    const [existingSkill] = await globalThis.services.db
      .select({ id: zeroSkills.id })
      .from(zeroSkills)
      .where(
        and(eq(zeroSkills.orgId, org.orgId), eq(zeroSkills.name, body.name)),
      )
      .limit(1);

    if (existingSkill) {
      return {
        status: 409 as const,
        body: {
          error: {
            message: `Skill "${body.name}" already exists in this organization`,
            code: "CONFLICT",
          },
        },
      };
    }

    // Insert into zero_skills
    await globalThis.services.db.insert(zeroSkills).values({
      orgId: org.orgId,
      name: body.name,
      displayName: body.displayName ?? null,
      description: body.description ?? null,
      createdBy: userId,
    });

    // Upload skill content to S3
    await uploadSkillServerSide({
      orgId: org.orgId,
      skillName: body.name,
      content: body.content,
    });

    // Append skill name to agent's customSkills
    const updatedSkills = [...(existing.customSkills ?? []), body.name];
    await globalThis.services.db
      .update(zeroAgents)
      .set({ customSkills: updatedSkills, updatedAt: new Date() })
      .where(eq(zeroAgents.id, params.id));

    // Rebuild compose with new volume declaration
    const content = buildComposeContent(
      existing.name,
      existing.connectors ?? [],
      updatedSkills.map((name) => ({ name })),
    );

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

    log.info(`Created custom skill "${body.name}" for agent ${existing.name}`);

    return {
      status: 201 as const,
      body: {
        name: body.name,
        displayName: body.displayName ?? null,
        description: body.description ?? null,
      },
    };
  },
});

const handler = createHandler(zeroAgentSkillsCollectionContract, router, {
  errorHandler: createSafeErrorHandler("zero-agents:skills"),
});

export { handler as GET, handler as POST };
