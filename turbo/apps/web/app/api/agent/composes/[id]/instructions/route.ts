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
import { NextResponse } from "next/server";
import { gunzipSync } from "node:zlib";
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
import { canAccessCompose } from "../../../../../../src/lib/agent/compose-access";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";
import {
  downloadManifest,
  downloadS3Buffer,
} from "../../../../../../src/lib/s3/s3-client";
import { env } from "../../../../../../src/env";
import {
  getInstructionsStorageName,
  getInstructionsFilename,
  injectMetadataFrontmatter,
  stripMetadataFrontmatter,
} from "@vm0/core";
import type { AgentComposeYaml } from "../../../../../../src/types/agent-compose";
import { extractFileFromTar } from "../../../../../../src/lib/tar";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  initServices();

  const authorization = request.headers.get("authorization") ?? undefined;
  const authResult = await requireAuth(authorization, {
    requiredCapability: "agent:read",
  });
  if (isAuthError(authResult)) {
    return NextResponse.json(authResult.body, { status: authResult.status });
  }
  const { userId } = authResult;

  const { id } = await params;

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
    return NextResponse.json(
      { error: { message: "Agent compose not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Check access (owner or org member).
  // Sandbox tokens (with capabilities) are already authorized via requireAuth;
  // use the compose's orgId since sandbox tokens lack org context.
  const orgId = authResult.capabilities
    ? result.orgId
    : (await resolveOrg(authResult)).org.orgId;
  const hasAccess = canAccessCompose(userId, orgId, result);
  if (!hasAccess) {
    return NextResponse.json(
      { error: { message: "Agent compose not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Extract instructions filename from compose content
  const content = result.content as AgentComposeYaml | null;
  if (!content?.agents) {
    return NextResponse.json({ content: null, filename: null });
  }

  const agentKeys = Object.keys(content.agents);
  const firstKey = agentKeys[0];
  const agentDef = firstKey ? content.agents[firstKey] : null;
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
    return NextResponse.json({ content: null, filename: instructionsFilename });
  }

  // Get the HEAD version to find S3 key
  const [version] = await globalThis.services.db
    .select()
    .from(storageVersions)
    .where(eq(storageVersions.id, storage.headVersionId))
    .limit(1);

  if (!version) {
    return NextResponse.json({ content: null, filename: instructionsFilename });
  }

  const bucket = env().R2_USER_STORAGES_BUCKET_NAME;

  // Download manifest to find the actual filename in storage
  const manifest = await downloadManifest(bucket, version.s3Key);

  // Derive the canonical filename from the agent's framework.
  // CLI uploads instructions with a framework-canonical name (e.g., CLAUDE.md
  // for claude-code). Use the same mapping to look up the file in the manifest,
  // ensuring the read path matches the write path.
  const canonicalFilename = getInstructionsFilename(agentDef?.framework);
  const normalize = (p: string) => (p.startsWith("./") ? p.slice(2) : p);
  const instructionFile = manifest.files.find(
    (f) => normalize(f.path) === normalize(canonicalFilename),
  );

  if (!instructionFile) {
    return NextResponse.json({ content: null, filename: instructionsFilename });
  }

  // Download and extract from the archive (CLI uploads archive.tar.gz, not individual blobs)
  const archiveKey = `${version.s3Key}/archive.tar.gz`;
  const archiveBuffer = await downloadS3Buffer(bucket, archiveKey);
  const tarBuffer = gunzipSync(archiveBuffer);
  const fileContent = extractFileFromTar(tarBuffer, instructionFile.path);

  if (!fileContent) {
    return NextResponse.json({
      content: null,
      filename: instructionsFilename,
    });
  }

  // Strip any metadata the CLI may have baked in, then inject fresh metadata
  // from the compose content so it always reflects the latest agent settings.
  const rawContent = fileContent.toString("utf-8");
  const metadata = extractAgentMetadata(content);
  const finalContent = metadata
    ? injectMetadataFrontmatter(stripMetadataFrontmatter(rawContent), metadata)
    : rawContent;

  return NextResponse.json({
    content: finalContent,
    filename: instructionsFilename,
  });
}

/**
 * Extract agent metadata from compose content for the first agent.
 */
function extractAgentMetadata(
  content: AgentComposeYaml,
): { displayName?: string; description?: string; sound?: string } | undefined {
  if (!content.agents) {
    return undefined;
  }
  const agentKey = Object.keys(content.agents)[0];
  if (!agentKey) {
    return undefined;
  }
  return content.agents[agentKey]?.metadata;
}
