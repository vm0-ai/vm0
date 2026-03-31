import { gunzipSync } from "node:zlib";
import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../../../src/lib/ts-rest-handler";
import {
  zeroAgentSkillsDetailContract,
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core";
import { initServices } from "../../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../../src/lib/org/resolve-org";
import { serverSideCompose } from "../../../../../../../src/lib/compose/server-side-compose";
import { zeroAgents } from "../../../../../../../src/db/schema/zero-agent";
import { zeroSkills } from "../../../../../../../src/db/schema/zero-skill";
import { agentComposes } from "../../../../../../../src/db/schema/agent-compose";
import {
  storages,
  storageVersions,
} from "../../../../../../../src/db/schema/storage";
import { eq, and, sql } from "drizzle-orm";
import { buildComposeContent } from "../../../../../../../src/lib/zero/build-compose-content";
import { requireAdminForDefaultAgent } from "../../../../../../../src/lib/zero/require-admin";
import {
  uploadSkillServerSide,
  deleteSkillServerSide,
} from "../../../../../../../src/lib/storage/skill-upload";
import {
  downloadManifest,
  downloadS3Buffer,
} from "../../../../../../../src/lib/s3/s3-client";
import { extractFileFromTar } from "../../../../../../../src/lib/tar";
import { env } from "../../../../../../../src/env";
import { logger } from "../../../../../../../src/lib/logger";

const log = logger("api:zero-agents:skills:detail");

const SKILL_FILENAME = "SKILL.md";

const router = tsr.router(zeroAgentSkillsDetailContract, {
  get: async ({ params, headers }, { request }) => {
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
        },
      };
    }

    const bucket = env().R2_USER_STORAGES_BUCKET_NAME;

    // Download manifest to find SKILL.md
    const manifest = await downloadManifest(bucket, version.s3Key);
    const normalize = (p: string) => (p.startsWith("./") ? p.slice(2) : p);
    const skillFile = manifest.files.find(
      (f) => normalize(f.path) === SKILL_FILENAME,
    );

    if (!skillFile) {
      return {
        status: 200 as const,
        body: {
          name: skill.name,
          displayName: skill.displayName ?? null,
          description: skill.description ?? null,
          content: null,
        },
      };
    }

    // Download and extract from the archive
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
      },
    };
  },

  update: async ({ params, body, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org, member } = await resolveOrg(authCtx, orgSlug);

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

    // Only admins can modify the default agent's skills
    const forbidden = await requireAdminForDefaultAgent(
      org.orgId,
      agent.id,
      member.role,
      "skills",
    );
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

    // Upload new content (creates new VAS version, no compose rebuild needed)
    await uploadSkillServerSide({
      orgId: org.orgId,
      skillName: params.name,
      content: body.content,
    });

    // Update timestamp
    await globalThis.services.db
      .update(zeroSkills)
      .set({ updatedAt: new Date() })
      .where(eq(zeroSkills.id, skill.id));

    log.info(`Updated custom skill "${params.name}" content`);

    return {
      status: 200 as const,
      body: {
        name: skill.name,
        displayName: skill.displayName ?? null,
        description: skill.description ?? null,
        content: body.content,
      },
    };
  },

  delete: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org, member } = await resolveOrg(authCtx, orgSlug);

    // Look up agent + compose name (need for compose rebuild)
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

    // Verify skill exists
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

    // Remove skill from this agent's customSkills
    const updatedSkills = (existing.customSkills ?? []).filter(
      (s) => s !== params.name,
    );
    await globalThis.services.db
      .update(zeroAgents)
      .set({ customSkills: updatedSkills, updatedAt: new Date() })
      .where(eq(zeroAgents.id, params.id));

    // Check if any other agent in the org still references this skill
    const [refCount] = await globalThis.services.db
      .select({ count: sql<number>`count(*)` })
      .from(zeroAgents)
      .where(
        and(
          eq(zeroAgents.orgId, org.orgId),
          sql`${zeroAgents.customSkills} @> ${JSON.stringify([params.name])}::jsonb`,
        ),
      );

    if ((refCount?.count ?? 0) === 0) {
      // No other agent references this skill — full cleanup
      await globalThis.services.db
        .delete(zeroSkills)
        .where(
          and(
            eq(zeroSkills.orgId, org.orgId),
            eq(zeroSkills.name, params.name),
          ),
        );
      await deleteSkillServerSide({
        orgId: org.orgId,
        skillName: params.name,
      });
    }

    // Rebuild compose (remove volume declaration)
    const content = buildComposeContent(
      existing.name,
      existing.connectors ?? [],
      updatedSkills.map((name) => ({ name })),
    );

    await serverSideCompose({
      userId,
      orgId: org.orgId,
      orgSlug: org.slug,
      content,
    });

    log.info(
      `Deleted custom skill "${params.name}" from agent ${existing.name}`,
    );

    return { status: 204 as const, body: undefined };
  },
});

const handler = createHandler(zeroAgentSkillsDetailContract, router, {
  errorHandler: createSafeErrorHandler("zero-agents:skills:detail"),
});

export { handler as GET, handler as PUT, handler as DELETE };
