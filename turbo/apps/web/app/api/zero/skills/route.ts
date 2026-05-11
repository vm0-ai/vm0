import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { zeroSkillsCollectionContract } from "@vm0/api-contracts/contracts/zero-agents";
import { getCustomSkillStorageName } from "@vm0/core/storage-names";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { zeroSkills } from "@vm0/db/schema/zero-skill";
import { eq, and } from "drizzle-orm";
import { uploadVolumeServerSide } from "../../../../src/lib/infra/storage/volume-upload";
import { SEED_SKILLS } from "../../../../src/lib/zero/seed-skills";
import { requireAdminPermission } from "../../../../src/lib/zero/require-agent-permission";
import { logger } from "../../../../src/lib/shared/logger";
import { isBadRequest } from "@vm0/api-services/errors";

const log = logger("api:zero-skills");

const router = tsr.router(zeroSkillsCollectionContract, {
  list: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authCtx)) return authCtx;

    let orgId: string;
    try {
      const { org } = await resolveOrg(authCtx);
      orgId = org.orgId;
    } catch (error) {
      if (isBadRequest(error)) {
        return {
          status: 401 as const,
          body: {
            error: { message: "Not authenticated", code: "UNAUTHORIZED" },
          },
        };
      }
      throw error;
    }

    const rows = await globalThis.services.db
      .select({
        name: zeroSkills.name,
        displayName: zeroSkills.displayName,
        description: zeroSkills.description,
      })
      .from(zeroSkills)
      .where(eq(zeroSkills.orgId, orgId));

    return {
      status: 200 as const,
      body: rows.map((r) => {
        return {
          name: r.name,
          displayName: r.displayName ?? null,
          description: r.description ?? null,
        };
      }),
    };
  },

  create: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org, member } = await resolveOrg(authCtx);

    // Only org admins can create custom skills
    const forbidden = requireAdminPermission(member, "create custom skills");
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

    // Upload skill files to S3
    await uploadVolumeServerSide({
      orgId: org.orgId,
      storageName: getCustomSkillStorageName(body.name),
      files: body.files,
    });

    log.info(`Created custom skill "${body.name}" in org ${org.orgId}`);

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

const handler = createHandler(zeroSkillsCollectionContract, router, {
  routeName: "zero.skills",
});

export { handler as GET, handler as POST };
