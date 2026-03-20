import { gunzipSync } from "node:zlib";
import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../../src/lib/ts-rest-handler";
import {
  zeroAgentInstructionsContract,
  getInstructionsStorageName,
  getInstructionsFilename,
  agentComposeApiContentSchema,
  stripMetadataFrontmatter,
} from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";
import { serverSideCompose } from "../../../../../../src/lib/compose/server-side-compose";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../../src/db/schema/agent-compose";
import { zeroAgents } from "../../../../../../src/db/schema/zero-agent";
import {
  storages,
  storageVersions,
} from "../../../../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";
import {
  downloadManifest,
  downloadS3Buffer,
} from "../../../../../../src/lib/s3/s3-client";
import { extractFileFromTar } from "../../../../../../src/lib/tar";
import { env } from "../../../../../../src/env";
import { extractConnectors } from "../../../../../../src/lib/zero/build-compose-content";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("api:zero-agents:instructions");

const router = tsr.router(zeroAgentInstructionsContract, {
  get: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authCtx)) return authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    // Look up compose by name + org
    const [compose] = await globalThis.services.db
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
        orgId: agentComposes.orgId,
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

    // Extract instructions filename from compose content
    const parsed = agentComposeApiContentSchema.safeParse(compose.content);
    if (!parsed.success) {
      return {
        status: 200 as const,
        body: { content: null, filename: null },
      };
    }

    const agentKeys = Object.keys(parsed.data.agents);
    const firstKey = agentKeys[0];
    const agentDef = firstKey ? parsed.data.agents[firstKey] : undefined;
    const instructionsFilename =
      agentDef?.instructions ?? getInstructionsFilename(agentDef?.framework);

    // Look up the instructions storage volume
    const storageName = getInstructionsStorageName(compose.name);
    const [storage] = await globalThis.services.db
      .select()
      .from(storages)
      .where(
        and(
          eq(storages.orgId, compose.orgId),
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

    // Download manifest
    const manifest = await downloadManifest(bucket, version.s3Key);

    const canonicalFilename = getInstructionsFilename(agentDef?.framework);
    const normalize = (p: string) => (p.startsWith("./") ? p.slice(2) : p);
    const instructionFile = manifest.files.find(
      (f) => normalize(f.path) === normalize(canonicalFilename),
    );

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

  update: async ({ params, body, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    // Look up existing compose
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

    // Re-compose with existing content + new instructions
    const existingContent = (compose.content ?? {}) as Record<string, unknown>;

    const result = await serverSideCompose({
      userId,
      orgId: org.orgId,
      orgSlug: org.slug,
      content: existingContent,
      instructions: body.content,
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

    log.info(`Updated instructions for zero agent: ${result.composeName}`);

    // Look up zero_agent metadata
    const [agent] = await globalThis.services.db
      .select()
      .from(zeroAgents)
      .where(
        and(eq(zeroAgents.orgId, org.orgId), eq(zeroAgents.name, params.name)),
      )
      .limit(1);

    return {
      status: 200 as const,
      body: {
        name: result.composeName,
        agentComposeId: result.composeId,
        description: agent?.description ?? null,
        displayName: agent?.displayName ?? null,
        sound: agent?.sound ?? null,
        connectors: extractConnectors(existingContent),
      },
    };
  },
});

const handler = createHandler(zeroAgentInstructionsContract, router, {
  errorHandler: createSafeErrorHandler("zero-agents:instructions"),
});

export { handler as GET, handler as PUT };
