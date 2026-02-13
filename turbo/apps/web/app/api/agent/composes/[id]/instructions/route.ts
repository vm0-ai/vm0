/**
 * GET /api/agent/composes/:id/instructions
 * PUT /api/agent/composes/:id/instructions
 *
 * Fetch or update the instructions content for an agent compose.
 * Instructions are stored as storage volumes (agent-instructions@{agentName})
 * and this endpoint reads/writes the content from/to S3.
 */
import { NextResponse } from "next/server";
import { gunzipSync, gzipSync } from "node:zlib";
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
import { scopes } from "../../../../../../src/db/schema/scope";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import { getUserEmail } from "../../../../../../src/lib/auth/get-user-email";
import { canAccessCompose } from "../../../../../../src/lib/agent/permission-service";
import {
  downloadManifest,
  downloadS3Buffer,
  putS3Object,
} from "../../../../../../src/lib/s3/s3-client";
import type { S3StorageManifest } from "../../../../../../src/lib/s3/types";
import { env } from "../../../../../../src/env";
import { getInstructionsStorageName } from "@vm0/core";
import type { AgentComposeYaml } from "../../../../../../src/types/agent-compose";
import {
  hashFileContent,
  computeContentHashFromHashes,
} from "../../../../../../src/lib/storage/content-hash";

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

  // Find the instructions file in manifest, normalizing ./ prefix.
  // Temporary fallback: if the configured filename isn't found, try CLAUDE.md
  // (some volumes were created with CLAUDE.md before the rename to AGENTS.md).
  const normalize = (p: string) => (p.startsWith("./") ? p.slice(2) : p);
  const instructionFile =
    manifest.files.find(
      (f) => normalize(f.path) === normalize(instructionsFilename),
    ) ?? manifest.files.find((f) => normalize(f.path) === "CLAUDE.md");

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

/**
 * Create a tar archive containing a single file.
 */
function createSingleFileTar(filename: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);

  // File name (bytes 0-99)
  header.write(filename, 0, Math.min(filename.length, 100), "utf-8");

  // File mode (bytes 100-107): 0644
  header.write("0000644\0", 100, 8, "utf-8");

  // UID/GID (bytes 108-123): 0
  header.write("0000000\0", 108, 8, "utf-8");
  header.write("0000000\0", 116, 8, "utf-8");

  // File size (bytes 124-135): octal
  header.write(
    content.length.toString(8).padStart(11, "0") + "\0",
    124,
    12,
    "utf-8",
  );

  // Mtime (bytes 136-147)
  const mtime = Math.floor(Date.now() / 1000)
    .toString(8)
    .padStart(11, "0");
  header.write(mtime + "\0", 136, 12, "utf-8");

  // Type flag (byte 156): '0' = regular file
  header.write("0", 156, 1, "utf-8");

  // Compute checksum: fill checksum field with spaces first
  header.write("        ", 148, 8, "utf-8");
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i] ?? 0;
  }
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf-8");

  // Pad content to 512-byte boundary
  const paddingSize = (512 - (content.length % 512)) % 512;
  const padding = Buffer.alloc(paddingSize);

  // End-of-archive marker: two 512-byte zero blocks
  const endMarker = Buffer.alloc(1024);

  return Buffer.concat([header, content, padding, endMarker]);
}

export async function PUT(
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

  // Ownership check — only the owner can edit instructions
  if (result.userId !== userId) {
    return NextResponse.json(
      { error: { message: "Forbidden", code: "FORBIDDEN" } },
      { status: 403 },
    );
  }

  // Parse request body
  const body = (await request.json()) as { content?: string };
  if (typeof body.content !== "string") {
    return NextResponse.json(
      { error: { message: "content is required", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  // Extract instructions filename from compose content
  const composeContent = result.content as AgentComposeYaml | null;
  if (!composeContent?.agents) {
    return NextResponse.json(
      {
        error: {
          message: "No agents configured in compose",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  const agentKeys = Object.keys(composeContent.agents);
  const firstKey = agentKeys[0];
  const agentDef = firstKey ? composeContent.agents[firstKey] : null;
  const instructionsFilename = agentDef?.instructions;

  if (!instructionsFilename) {
    return NextResponse.json(
      {
        error: {
          message: "No instructions file configured",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  // Get scope slug for S3 key construction
  const [scope] = await globalThis.services.db
    .select({ slug: scopes.slug })
    .from(scopes)
    .where(eq(scopes.id, result.scopeId))
    .limit(1);

  if (!scope) {
    return NextResponse.json(
      { error: { message: "Scope not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }

  // Find or create the instructions storage volume
  const storageName = getInstructionsStorageName(result.name);
  let [storage] = await globalThis.services.db
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

  if (!storage) {
    const [newStorage] = await globalThis.services.db
      .insert(storages)
      .values({
        userId,
        scopeId: result.scopeId,
        name: storageName,
        type: "volume",
        s3Prefix: `${scope.slug}/volume/${storageName}`,
        size: 0,
        fileCount: 0,
      })
      .returning();
    storage = newStorage;
  }

  if (!storage) {
    return NextResponse.json(
      { error: { message: "Failed to create storage", code: "INTERNAL" } },
      { status: 500 },
    );
  }

  // Compute content hash and version ID
  const contentBuffer = Buffer.from(body.content, "utf-8");
  const contentHash = hashFileContent(contentBuffer);
  const files = [
    {
      path: instructionsFilename,
      hash: contentHash,
      size: contentBuffer.length,
    },
  ];
  const versionId = computeContentHashFromHashes(storage.id, files);

  // Build S3 key and upload archive + manifest
  const s3Key = `${scope.slug}/volume/${storageName}/${versionId}`;
  const bucket = env().R2_USER_STORAGES_BUCKET_NAME;

  const manifest: S3StorageManifest = {
    version: versionId,
    createdAt: new Date().toISOString(),
    totalSize: contentBuffer.length,
    fileCount: 1,
    files,
  };

  const tarBuffer = createSingleFileTar(instructionsFilename, contentBuffer);
  const archiveBuffer = gzipSync(tarBuffer);

  await Promise.all([
    putS3Object(
      bucket,
      `${s3Key}/manifest.json`,
      JSON.stringify(manifest),
      "application/json",
    ),
    putS3Object(
      bucket,
      `${s3Key}/archive.tar.gz`,
      archiveBuffer,
      "application/gzip",
    ),
  ]);

  // DB transaction: create version + update HEAD pointer
  await globalThis.services.db.transaction(async (tx) => {
    await tx
      .insert(storageVersions)
      .values({
        id: versionId,
        storageId: storage.id,
        s3Key,
        size: contentBuffer.length,
        fileCount: 1,
        message: null,
        createdBy: "user",
      })
      .onConflictDoNothing();

    const [version] = await tx
      .select({ id: storageVersions.id })
      .from(storageVersions)
      .where(eq(storageVersions.id, versionId))
      .limit(1);

    if (!version) {
      throw new Error(`Version ${versionId} not found after insert`);
    }

    await tx
      .update(storages)
      .set({
        headVersionId: versionId,
        size: contentBuffer.length,
        fileCount: 1,
        updatedAt: new Date(),
      })
      .where(eq(storages.id, storage.id));
  });

  return NextResponse.json({ success: true });
}
