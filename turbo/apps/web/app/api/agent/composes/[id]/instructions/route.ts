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
import {
  createSingleFileTar,
  extractFileFromTar,
} from "../../../../../../src/lib/tar";

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

  const MAX_CONTENT_SIZE = 1024 * 1024; // 1 MB
  if (Buffer.byteLength(body.content, "utf-8") > MAX_CONTENT_SIZE) {
    return NextResponse.json(
      {
        error: {
          message: "Content too large (max 1 MB)",
          code: "PAYLOAD_TOO_LARGE",
        },
      },
      { status: 413 },
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

  // Upload to S3 before the DB transaction. If the DB transaction fails,
  // orphaned S3 objects are benign because keys are content-addressable —
  // the version ID won't be referenced, and re-uploading the same content
  // produces the same key (idempotent).
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
