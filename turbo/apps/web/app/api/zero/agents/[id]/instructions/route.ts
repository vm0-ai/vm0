import { gunzipSync } from "node:zlib";
import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import {
  zeroAgentInstructionsContract,
  getInstructionsStorageName,
  getInstructionsFilename,
  agentComposeApiContentSchema,
  stripMetadataFrontmatter,
  toFirewallPolicies,
} from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { serverSideCompose } from "../../../../../../src/lib/infra/compose/server-side-compose";
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
} from "../../../../../../src/lib/infra/s3/s3-client";
import { extractFileFromTar } from "../../../../../../src/lib/infra/tar";
import { env } from "../../../../../../src/env";
import { buildComposeContent } from "../../../../../../src/lib/zero/build-compose-content";
import {
  requireAgentPermission,
  requireAdminPermission,
} from "../../../../../../src/lib/zero/require-agent-permission";
import { logger } from "../../../../../../src/lib/shared/logger";

const log = logger("api:zero-agents:instructions");

async function updateInstructions(
  compose: { name: string },
  instructionsContent: string,
  userId: string,
  orgId: string,
) {
  const content = buildComposeContent(compose.name);

  const result = await serverSideCompose({
    userId,
    orgId,
    content,
    instructions: instructionsContent,
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

  const [agent] = await globalThis.services.db
    .select()
    .from(zeroAgents)
    .where(and(eq(zeroAgents.orgId, orgId), eq(zeroAgents.name, compose.name)))
    .limit(1);

  return {
    status: 200 as const,
    body: {
      agentId: result.composeId,
      ownerId: agent?.owner ?? userId,
      description: agent?.description ?? null,
      displayName: agent?.displayName ?? null,
      sound: agent?.sound ?? null,
      avatarUrl: agent?.avatarUrl ?? null,
      permissionPolicies: toFirewallPolicies(
        agent?.permissionPolicies,
        agent?.unknownPermissionPolicies,
      ),
      modelProviderId: agent?.modelProviderId ?? null,
      selectedModel: agent?.selectedModel ?? null,
      customSkills: agent?.customSkills ?? [],
    },
  };
}

const router = tsr.router(zeroAgentInstructionsContract, {
  get: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    // Look up compose by ID
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
          eq(agentComposes.id, params.id),
        ),
      )
      .limit(1);

    if (!compose) {
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

  update: async ({ params, body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org, member } = await resolveOrg(authCtx);

    // Look up existing compose by ID
    const [compose] = await globalThis.services.db
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
        content: agentComposeVersions.content,
        customSkills: zeroAgents.customSkills,
        owner: zeroAgents.owner,
      })
      .from(agentComposes)
      .leftJoin(
        agentComposeVersions,
        eq(agentComposes.headVersionId, agentComposeVersions.id),
      )
      .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .where(
        and(
          eq(agentComposes.orgId, org.orgId),
          eq(agentComposes.id, params.id),
        ),
      )
      .limit(1);

    if (!compose) {
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

    // Only agent owner or org admin can update instructions.
    // When no zeroAgents row exists (owner is null), fall back to admin-only.
    const forbidden = compose.owner
      ? requireAgentPermission(
          compose.owner,
          member,
          "update agent instructions",
        )
      : requireAdminPermission(member, "update agent instructions");
    if (forbidden) return forbidden;

    return updateInstructions(compose, body.content, userId, org.orgId);
  },
});

const handler = createHandler(zeroAgentInstructionsContract, router, {
  routeName: "zero.agents.instructions",
});

export { handler as GET, handler as PUT };
