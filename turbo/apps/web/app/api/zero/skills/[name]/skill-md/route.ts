import { gunzipSync } from "node:zlib";
import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../../src/lib/ts-rest-handler";
import {
  zeroSkillsSkillMdContract,
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
  zeroAgentSkillFilesRequestSchema,
} from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { zeroSkills } from "../../../../../../src/db/schema/zero-skill";
import {
  storages,
  storageVersions,
} from "../../../../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";
import { uploadSkillServerSide } from "../../../../../../src/lib/infra/storage/skill-upload";
import {
  downloadManifest,
  downloadS3Buffer,
} from "../../../../../../src/lib/infra/s3/s3-client";
import { extractAllFilesFromTar } from "../../../../../../src/lib/infra/tar";
import { env } from "../../../../../../src/env";
import { requireAdminPermission } from "../../../../../../src/lib/zero/require-agent-permission";
import { logger } from "../../../../../../src/lib/shared/logger";

const log = logger("api:zero-skills:skill-md");

const SKILL_FILENAME = "SKILL.md";

async function loadOtherFiles(
  headVersionId: string,
): Promise<{ path: string; content: string }[]> {
  const [version] = await globalThis.services.db
    .select()
    .from(storageVersions)
    .where(eq(storageVersions.id, headVersionId))
    .limit(1);
  if (!version) {
    return [];
  }
  const bucket = env().R2_USER_STORAGES_BUCKET_NAME;
  const archiveKey = `${version.s3Key}/archive.tar.gz`;
  const archiveBuffer = await downloadS3Buffer(bucket, archiveKey);
  const tarBuffer = gunzipSync(archiveBuffer);
  const allFiles = extractAllFilesFromTar(tarBuffer);
  const result: { path: string; content: string }[] = [];
  for (const file of allFiles) {
    if (file.path === SKILL_FILENAME) {
      continue;
    }
    result.push({
      path: file.path,
      content: file.content.toString("utf-8"),
    });
  }
  return result;
}

async function loadStorageFilesList(
  orgId: string,
  storageName: string,
  fallback: { path: string; content: string }[],
): Promise<{ path: string; size: number }[]> {
  const [postStorage] = await globalThis.services.db
    .select()
    .from(storages)
    .where(
      and(
        eq(storages.orgId, orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, storageName),
        eq(storages.type, "volume"),
      ),
    )
    .limit(1);
  if (postStorage?.headVersionId) {
    const [postVersion] = await globalThis.services.db
      .select()
      .from(storageVersions)
      .where(eq(storageVersions.id, postStorage.headVersionId))
      .limit(1);
    if (postVersion) {
      const bucket = env().R2_USER_STORAGES_BUCKET_NAME;
      const manifest = await downloadManifest(bucket, postVersion.s3Key);
      return manifest.files.map((f) => {
        const path = f.path.startsWith("./") ? f.path.slice(2) : f.path;
        return { path, size: f.size };
      });
    }
  }
  return fallback.map((f) => {
    return {
      path: f.path,
      size: new TextEncoder().encode(f.content).length,
    };
  });
}

const router = tsr.router(zeroSkillsSkillMdContract, {
  patchSkillMd: async ({ params, body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { org, member } = await resolveOrg(authCtx);

    const forbidden = requireAdminPermission(member, "edit custom skills");
    if (forbidden) return forbidden;

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

    // Resolve storage to figure out which other files (if any) we must preserve.
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

    // Build the merged file list: new SKILL.md + every existing non-SKILL.md
    // file. For brand-new skills with no HEAD version yet, the merged list
    // contains only SKILL.md.
    const mergedFiles: { path: string; content: string }[] = [
      { path: SKILL_FILENAME, content: body.content },
    ];

    if (storage?.headVersionId) {
      const otherFiles = await loadOtherFiles(storage.headVersionId);
      mergedFiles.push(...otherFiles);
    }

    // Validate the merged set against the same schema the PUT endpoint uses,
    // so we cannot accidentally exceed the 5MB / 500 file limits.
    const validation = zeroAgentSkillFilesRequestSchema.safeParse({
      files: mergedFiles,
    });
    if (!validation.success) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: validation.error.issues[0]?.message ?? "Invalid skill",
            code: "INVALID_INPUT",
          },
        },
      };
    }

    await uploadSkillServerSide({
      orgId: org.orgId,
      skillName: params.name,
      files: mergedFiles,
    });

    // Apply optional metadata edits in the same flow.
    const metadataUpdate: Partial<typeof zeroSkills.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (body.displayName !== undefined) {
      metadataUpdate.displayName = body.displayName;
    }
    if (body.description !== undefined) {
      metadataUpdate.description = body.description;
    }

    await globalThis.services.db
      .update(zeroSkills)
      .set(metadataUpdate)
      .where(eq(zeroSkills.id, skill.id));

    log.info(
      `Patched SKILL.md for "${params.name}" (${mergedFiles.length} files preserved)`,
    );

    // Re-read fresh metadata for the response.
    const [updated] = await globalThis.services.db
      .select()
      .from(zeroSkills)
      .where(eq(zeroSkills.id, skill.id))
      .limit(1);

    const filesList = await loadStorageFilesList(
      org.orgId,
      storageName,
      mergedFiles,
    );

    return {
      status: 200 as const,
      body: {
        name: updated?.name ?? skill.name,
        displayName: updated?.displayName ?? null,
        description: updated?.description ?? null,
        content: body.content,
        files: filesList,
      },
    };
  },
});

const handler = createHandler(zeroSkillsSkillMdContract, router, {
  errorHandler: createSafeErrorHandler("zero-skills:skill-md"),
});

export { handler as PATCH };
