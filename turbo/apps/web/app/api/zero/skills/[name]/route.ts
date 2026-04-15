import { gunzipSync } from "node:zlib";
import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import {
  zeroSkillsDetailContract,
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { serverSideCompose } from "../../../../../src/lib/infra/compose/server-side-compose";
import { zeroAgents } from "../../../../../src/db/schema/zero-agent";
import { zeroSkills } from "../../../../../src/db/schema/zero-skill";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import {
  storages,
  storageVersions,
} from "../../../../../src/db/schema/storage";
import { eq, and, sql } from "drizzle-orm";
import { buildComposeContent } from "../../../../../src/lib/zero/build-compose-content";
import {
  uploadSkillServerSide,
  deleteSkillServerSide,
} from "../../../../../src/lib/infra/storage/skill-upload";
import {
  downloadManifest,
  downloadS3Buffer,
} from "../../../../../src/lib/infra/s3/s3-client";
import { extractFileFromTar } from "../../../../../src/lib/infra/tar";
import { env } from "../../../../../src/env";
import { requireAdminPermission } from "../../../../../src/lib/zero/require-agent-permission";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("api:zero-skills:detail");

const SKILL_FILENAME = "SKILL.md";

const router = tsr.router(zeroSkillsDetailContract, {
  get: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    // Look up skill metadata
    const [skill] = await globalThis.services.db
      .select()
      .from(zeroSkills)
      .where(
        and(eq(zeroSkills.orgId, org.orgId), eq(zeroSkills.name, params.name)),
      )
      .limit(1);

    if (!skill) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Skill not found: ${params.name}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Resolve storage to download content
    const storageName = getCustomSkillStorageName(params.name);
    const [storage] = await globalThis.services.db
      .select()
      .from(storages)
      .where(
        and(
          eq(storages.orgId, org.orgId),
          eq(storages.userId, VOLUME_ORG_USER_ID),
          eq(storages.name, storageName),
          eq(storages.type, "volume"),
        ),
      )
      .limit(1);

    if (!storage?.headVersionId) {
      return {
        status: 200 as const,
        body: {
          name: skill.name,
          displayName: skill.displayName ?? null,
          description: skill.description ?? null,
          content: null,
          files: null,
        },
      };
    }

    // Get HEAD version
    const [version] = await globalThis.services.db
      .select()
      .from(storageVersions)
      .where(eq(storageVersions.id, storage.headVersionId))
      .limit(1);

    if (!version) {
      return {
        status: 200 as const,
        body: {
          name: skill.name,
          displayName: skill.displayName ?? null,
          description: skill.description ?? null,
          content: null,
          files: null,
        },
      };
    }

    const bucket = env().R2_USER_STORAGES_BUCKET_NAME;

    // Download manifest to get file listing and find SKILL.md
    const manifest = await downloadManifest(bucket, version.s3Key);
    const normalize = (p: string) => {
      return p.startsWith("./") ? p.slice(2) : p;
    };
    const skillFile = manifest.files.find((f) => {
      return normalize(f.path) === SKILL_FILENAME;
    });

    const filesList = manifest.files.map((f) => {
      return {
        path: normalize(f.path),
        size: f.size,
      };
    });

    if (!skillFile) {
      return {
        status: 200 as const,
        body: {
          name: skill.name,
          displayName: skill.displayName ?? null,
          description: skill.description ?? null,
          content: null,
          files: filesList,
        },
      };
    }

    // Download and extract SKILL.md from the archive
    const archiveKey = `${version.s3Key}/archive.tar.gz`;
    const archiveBuffer = await downloadS3Buffer(bucket, archiveKey);
    const tarBuffer = gunzipSync(archiveBuffer);
    const fileContent = extractFileFromTar(tarBuffer, skillFile.path);

    return {
      status: 200 as const,
      body: {
        name: skill.name,
        displayName: skill.displayName ?? null,
        description: skill.description ?? null,
        content: fileContent ? fileContent.toString("utf-8") : null,
        files: filesList,
      },
    };
  },

  update: async ({ params, body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);

    // Only org admins can update custom skills
    const forbidden = requireAdminPermission(member, "update custom skills");
    if (forbidden) return forbidden;

    // Look up skill
    const [skill] = await globalThis.services.db
      .select()
      .from(zeroSkills)
      .where(
        and(eq(zeroSkills.orgId, org.orgId), eq(zeroSkills.name, params.name)),
      )
      .limit(1);

    if (!skill) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Skill not found: ${params.name}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Upload new files (creates new version, no compose rebuild needed)
    await uploadSkillServerSide({
      orgId: org.orgId,
      skillName: params.name,
      files: body.files,
    });

    // Update timestamp
    await globalThis.services.db
      .update(zeroSkills)
      .set({ updatedAt: new Date() })
      .where(eq(zeroSkills.id, skill.id));

    log.info(`Updated custom skill "${params.name}" content`);

    const skillMd = body.files.find((f) => {
      return f.path === "SKILL.md";
    });

    return {
      status: 200 as const,
      body: {
        name: skill.name,
        displayName: skill.displayName ?? null,
        description: skill.description ?? null,
        content: skillMd?.content ?? null,
        files: body.files.map((f) => {
          return {
            path: f.path,
            size: new TextEncoder().encode(f.content).length,
          };
        }),
      },
    };
  },

  delete: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org, member } = await resolveOrg(authCtx);

    // Only org admins can delete custom skills
    const forbidden = requireAdminPermission(member, "delete custom skills");
    if (forbidden) return forbidden;

    // Look up skill
    const [skill] = await globalThis.services.db
      .select({ id: zeroSkills.id })
      .from(zeroSkills)
      .where(
        and(eq(zeroSkills.orgId, org.orgId), eq(zeroSkills.name, params.name)),
      )
      .limit(1);

    if (!skill) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Skill not found: ${params.name}`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Find all agents in the org that reference this skill
    const affectedAgents = await globalThis.services.db
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
        customSkills: zeroAgents.customSkills,
      })
      .from(agentComposes)
      .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .where(
        and(
          eq(agentComposes.orgId, org.orgId),
          sql`${zeroAgents.customSkills} @> ${JSON.stringify([params.name])}::jsonb`,
        ),
      );

    // Remove skill from each affected agent and rebuild compose
    for (const agent of affectedAgents) {
      const updatedSkills = (agent.customSkills ?? []).filter((s) => {
        return s !== params.name;
      });
      await globalThis.services.db
        .update(zeroAgents)
        .set({ customSkills: updatedSkills, updatedAt: new Date() })
        .where(eq(zeroAgents.id, agent.id));

      // Rebuild compose (best-effort — skill deletion proceeds even if compose rebuild fails)
      const content = buildComposeContent(agent.name);

      try {
        await serverSideCompose({
          userId,
          orgId: org.orgId,
          content,
        });
      } catch (e) {
        log.warn(
          `Failed to rebuild compose for agent ${agent.name} after skill deletion: ${e}`,
        );
      }
    }

    // Delete from zero_skills
    await globalThis.services.db
      .delete(zeroSkills)
      .where(
        and(eq(zeroSkills.orgId, org.orgId), eq(zeroSkills.name, params.name)),
      );

    // Delete S3 storage
    await deleteSkillServerSide({
      orgId: org.orgId,
      skillName: params.name,
    });

    log.info(
      `Deleted custom skill "${params.name}" from org ${org.orgId} (unbound from ${affectedAgents.length} agents)`,
    );

    return { status: 204 as const, body: undefined };
  },
});

const handler = createHandler(zeroSkillsDetailContract, router, {
  errorHandler: createSafeErrorHandler("zero-skills:detail"),
});

export { handler as GET, handler as PUT, handler as DELETE };
