/**
 * GET /api/agent/composes/:id/instructions
 *
 * Fetch the instructions content for an agent compose.
 * Instructions are stored as storage volumes (agent-instructions@{agentName})
 * and this endpoint reads the content from S3.
 *
 * Writing instructions is handled through the compose job flow
 * (POST /api/compose/jobs) which runs in an E2B sandbox.
 */
import { gunzipSync } from "node:zlib";
import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { composesInstructionsContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { eq, and } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../../src/db/schema/agent-compose";
import {
  storages,
  storageVersions,
} from "../../../../../../src/db/schema/storage";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { canAccessCompose } from "../../../../../../src/lib/infra/agent/compose-access";
import { isSandboxAuth } from "../../../../../../src/lib/auth/capability-check";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import {
  downloadManifest,
  downloadS3Buffer,
} from "../../../../../../src/lib/infra/s3/s3-client";
import { env } from "../../../../../../src/env";
import {
  getInstructionsStorageName,
  getInstructionsFilename,
  stripMetadataFrontmatter,
  agentComposeApiContentSchema,
} from "@vm0/core";
import { extractFileFromTar } from "../../../../../../src/lib/infra/tar";

const router = tsr.router(composesInstructionsContract, {
  getInstructions: async ({ params, headers }) => {
    initServices();

    const authResult = await requireAuth(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (isAuthError(authResult)) return authResult;
    const { userId } = authResult;

    const { id } = params;

    // Get compose with HEAD version content
    const [result] = await globalThis.services.db
      .select({
        id: agentComposes.id,
        userId: agentComposes.userId,
        orgId: agentComposes.orgId,
        name: agentComposes.name,
        content: agentComposeVersions.content,
      })
      .from(agentComposes)
      .leftJoin(
        agentComposeVersions,
        eq(agentComposes.headVersionId, agentComposeVersions.id),
      )
      .where(eq(agentComposes.id, id))
      .limit(1);

    if (!result) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent compose not found", code: "NOT_FOUND" },
        },
      };
    }

    // Check access (owner or org member).
    // Sandbox tokens are already authorized via requireAuth;
    // use the compose's orgId since sandbox tokens lack org context.
    const orgId = isSandboxAuth(authResult)
      ? result.orgId
      : (await resolveOrg(authResult)).org.orgId;
    const hasAccess = canAccessCompose(userId, orgId, result);
    if (!hasAccess) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent compose not found", code: "NOT_FOUND" },
        },
      };
    }

    // Extract instructions filename from compose content
    const parsed = agentComposeApiContentSchema.safeParse(result.content);
    if (!parsed.success) {
      return {
        status: 200 as const,
        body: { content: null, filename: null },
      };
    }

    const agentKeys = Object.keys(parsed.data.agents);
    const firstKey = agentKeys[0];
    const agentDef = firstKey ? parsed.data.agents[firstKey] : undefined;
    // Use the explicit instructions filename from YAML, or fall back to the
    // framework-canonical name (e.g. CLAUDE.md for claude-code).  The CLI may
    // upload instructions without setting the `instructions` field in the YAML.
    const instructionsFilename =
      agentDef?.instructions ?? getInstructionsFilename(agentDef?.framework);

    // Look up the instructions storage volume
    const storageName = getInstructionsStorageName(result.name);
    const [storage] = await globalThis.services.db
      .select()
      .from(storages)
      .where(
        and(
          eq(storages.orgId, result.orgId),
          eq(storages.name, storageName),
          eq(storages.type, "volume"),
        ),
      )
      .limit(1);

    if (!storage?.headVersionId) {
      return {
        status: 200 as const,
        body: { content: null, filename: instructionsFilename },
      };
    }

    // Get the HEAD version to find S3 key
    const [version] = await globalThis.services.db
      .select()
      .from(storageVersions)
      .where(eq(storageVersions.id, storage.headVersionId))
      .limit(1);

    if (!version) {
      return {
        status: 200 as const,
        body: { content: null, filename: instructionsFilename },
      };
    }

    const bucket = env().R2_USER_STORAGES_BUCKET_NAME;

    // Download manifest to find the actual filename in storage
    const manifest = await downloadManifest(bucket, version.s3Key);

    // Derive the canonical filename from the agent's framework.
    const canonicalFilename = getInstructionsFilename(agentDef?.framework);
    const normalize = (p: string) => {
      return p.startsWith("./") ? p.slice(2) : p;
    };
    const instructionFile = manifest.files.find((f) => {
      return normalize(f.path) === normalize(canonicalFilename);
    });

    if (!instructionFile) {
      return {
        status: 200 as const,
        body: { content: null, filename: instructionsFilename },
      };
    }

    // Download and extract from the archive
    const archiveKey = `${version.s3Key}/archive.tar.gz`;
    const archiveBuffer = await downloadS3Buffer(bucket, archiveKey);
    const tarBuffer = gunzipSync(archiveBuffer);
    const fileContent = extractFileFromTar(tarBuffer, instructionFile.path);

    if (!fileContent) {
      return {
        status: 200 as const,
        body: { content: null, filename: instructionsFilename },
      };
    }

    // Strip any legacy metadata blocks
    const rawContent = fileContent.toString("utf-8");
    const hasLegacyBlocks =
      rawContent.includes("[AGENT_PROFILE]") ||
      rawContent.includes("<!-- ZERO_PROFILE");
    const finalContent = hasLegacyBlocks
      ? stripMetadataFrontmatter(rawContent)
      : rawContent;

    return {
      status: 200 as const,
      body: { content: finalContent, filename: instructionsFilename },
    };
  },
});

const handler = createHandler(composesInstructionsContract, router, {
  routeName: "agent.composes.instructions",
});

export { handler as GET };
