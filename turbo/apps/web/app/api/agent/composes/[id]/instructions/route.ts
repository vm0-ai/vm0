/**
 * GET /api/agent/composes/:id/instructions
 *
 * Fetch the instructions content for an agent compose.
 * Instructions are stored as storage volumes (agent-instructions@{agentName})
 * and this endpoint reads the content from S3.
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
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import { getUserEmail } from "../../../../../../src/lib/auth/get-user-email";
import { canAccessCompose } from "../../../../../../src/lib/agent/permission-service";
import {
  downloadManifest,
  downloadS3Buffer,
} from "../../../../../../src/lib/s3/s3-client";
import { env } from "../../../../../../src/env";
import { getInstructionsStorageName } from "@vm0/core";
import type { AgentComposeYaml } from "../../../../../../src/types/agent-compose";

/**
 * Extract a single file from a tar archive buffer.
 * Tar format: 512-byte header + file data (padded to 512-byte blocks).
 */
function extractFileFromTar(
  tarBuffer: Buffer,
  targetPath: string,
): Buffer | null {
  let offset = 0;
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);

    // End of archive: two consecutive zero blocks
    if (header.every((b) => b === 0)) break;

    // File name: bytes 0-99, null-terminated
    const nameEnd = header.indexOf(0);
    const name = header
      .subarray(0, nameEnd > 0 && nameEnd < 100 ? nameEnd : 100)
      .toString("utf-8");

    // File size: bytes 124-135, octal string
    const sizeStr = header.subarray(124, 136).toString("utf-8").trim();
    const size = parseInt(sizeStr, 8) || 0;

    offset += 512; // Move past header

    if (name === targetPath || name === `./${targetPath}`) {
      return tarBuffer.subarray(offset, offset + size);
    }

    // Skip file data (padded to 512-byte boundary)
    offset += Math.ceil(size / 512) * 512;
  }
  return null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  initServices();

  const authorization = request.headers.get("authorization") ?? undefined;
  const userId = await getUserId(authorization);
  if (!userId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const { id } = await params;

  // Get compose with HEAD version content
  const [result] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      userId: agentComposes.userId,
      scopeId: agentComposes.scopeId,
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

  // Check access (owner or shared via email/public)
  const userEmail = await getUserEmail(userId);
  const hasAccess = await canAccessCompose(userId, userEmail, result);
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
  const instructionsFilename = agentDef?.instructions;

  if (!instructionsFilename) {
    return NextResponse.json({ content: null, filename: null });
  }

  // Look up the instructions storage volume
  const storageName = getInstructionsStorageName(result.name);
  const [storage] = await globalThis.services.db
    .select()
    .from(storages)
    .where(
      and(
        eq(storages.scopeId, result.scopeId),
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

  // Find the instructions file in manifest by exact path match
  const instructionFile = manifest.files.find(
    (f) => f.path === instructionsFilename,
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

  return NextResponse.json({
    content: fileContent.toString("utf-8"),
    filename: instructionsFilename,
  });
}
