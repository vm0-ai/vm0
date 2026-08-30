import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "1032_remove_chat_event_projection_metadata";
export const SOCIALKIT_VIDEO_ARTIFACT_MIGRATION =
  "1033_socialkit_video_artifact_marker";
const testDatabase = "migration_socialkit_video_artifact_30349";
const VIDEO_MARKER = "zero-official-video";

const fixture = {
  orgId: "org_socialkit_video_artifact_migration",
  historical: {
    userId: "user_socialkit_video_artifact_historical",
    sessionId: "00000000-0000-4000-8000-000000303490",
    runId: "00000000-0000-4000-8000-000000303491",
  },
  oldWriter: {
    userId: "user_socialkit_video_artifact_old_writer",
    sessionId: "00000000-0000-4000-8000-000000303492",
    runId: "00000000-0000-4000-8000-000000303493",
  },
  canonical: {
    userId: "user_socialkit_video_artifact_canonical",
    sessionId: "00000000-0000-4000-8000-000000303494",
    runId: "00000000-0000-4000-8000-000000303495",
  },
  historicalMp4JobId: "00000000-0000-4000-8000-000000303496",
  historicalMp4FileId: "00000000-0000-4000-8000-000000303497",
  historicalM4aJobId: "00000000-0000-4000-8000-000000303498",
  historicalM4aFileId: "00000000-0000-4000-8000-000000303499",
  mismatchedJobId: "00000000-0000-4000-8000-000000303500",
  mismatchedFileId: "00000000-0000-4000-8000-000000303501",
  ordinaryVideoFileId: "00000000-0000-4000-8000-000000303502",
  inFlightJobId: "00000000-0000-4000-8000-000000303507",
  inFlightFileId: "00000000-0000-4000-8000-000000303508",
  oldWriterJobId: "00000000-0000-4000-8000-000000303503",
  oldWriterFileId: "00000000-0000-4000-8000-000000303504",
  canonicalJobId: "00000000-0000-4000-8000-000000303505",
  canonicalFileId: "00000000-0000-4000-8000-000000303506",
  malformedFileId: "00000000-0000-4000-8000-000000303509",
} as const;

interface OwnerFixture {
  readonly runId: string;
  readonly sessionId: string;
  readonly userId: string;
}

interface FileState {
  readonly externalId: string;
  readonly metadata: Record<string, unknown>;
  readonly pending: boolean;
}

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function seedOwner(client: Client, owner: OwnerFixture): Promise<void> {
  await client.query(
    `
      INSERT INTO "agent_sessions" ("id", "user_id", "org_id")
      VALUES ($1, $2, $3)
    `,
    [owner.sessionId, owner.userId, fixture.orgId],
  );
  await client.query(
    `
      INSERT INTO "agent_runs" (
        "id", "user_id", "org_id", "session_id", "status", "prompt"
      ) VALUES ($1, $2, $3, $4, 'completed', 'SocialKit migration')
    `,
    [owner.runId, owner.userId, fixture.orgId, owner.sessionId],
  );
}

async function seedDownloadJob(
  client: Client,
  args: {
    readonly format: "m4a" | "mp4";
    readonly id: string;
    readonly owner: OwnerFixture;
    readonly providerJobId: string;
    readonly status: "completed" | "materializing";
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO "socialkit_download_jobs" (
        "id", "status", "org_id", "user_id", "run_id", "public_brand",
        "request", "provider_job_id"
      ) VALUES ($1, $2, $3, $4, $5, 'okou', $6::jsonb, $7)
    `,
    [
      args.id,
      args.status,
      fixture.orgId,
      args.owner.userId,
      args.owner.runId,
      JSON.stringify({
        platform: "youtube",
        url: `https://youtu.be/${args.id}`,
        maxDuration: 120,
        quality: "720p",
        format: args.format,
      }),
      args.providerJobId,
    ],
  );
}

async function seedFile(
  client: Client,
  args: {
    readonly contentType: string;
    readonly externalId: string;
    readonly fileId: string;
    readonly metadata: Record<string, unknown>;
    readonly owner: OwnerFixture;
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO "run_uploaded_files" (
        "id", "run_id", "source", "external_id", "user_id", "org_id",
        "filename", "content_type", "size_bytes", "url", "metadata"
      ) VALUES (
        $1::uuid, $2, 'web', $3, $4, $5, $6, $7, 128,
        'https://files.example.test/' || $1::text, $8::jsonb
      )
    `,
    [
      args.fileId,
      args.owner.runId,
      args.externalId,
      args.owner.userId,
      fixture.orgId,
      `artifact-${args.fileId}`,
      args.contentType,
      JSON.stringify(args.metadata),
    ],
  );
}

async function readFileStates(
  client: Client,
  fileIds: readonly string[],
): Promise<ReadonlyMap<string, FileState>> {
  const result = await client.query<FileState>(
    `
      SELECT
        "file"."external_id" AS "externalId",
        "file"."metadata",
        "pending"."file_id" IS NOT NULL AS "pending"
      FROM "run_uploaded_files" AS "file"
      LEFT JOIN "artifact_catalog_pending_files" AS "pending"
        ON "pending"."file_id" = "file"."id"
      WHERE "file"."id" = ANY($1::uuid[])
      ORDER BY "file"."external_id"
    `,
    [fileIds],
  );
  return new Map(
    result.rows.map((row) => {
      return [row.externalId, row];
    }),
  );
}

function requiredFile(
  rows: ReadonlyMap<string, FileState>,
  externalId: string,
): FileState {
  const row = rows.get(externalId);
  assert.ok(row, `Missing file state for ${externalId}`);
  return row;
}

export async function validateSocialKitVideoArtifactMigration(): Promise<void> {
  console.log("=== Validate SocialKit video artifact migration ===\n");

  const baseUrl = process.env.DATABASE_URL;
  assert.ok(baseUrl, "DATABASE_URL is required");
  const admin = new Client({
    connectionString: databaseUrl(baseUrl, "postgres"),
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${testDatabase}"`);

  const client = new Client({
    connectionString: databaseUrl(baseUrl, testDatabase),
  });
  await client.connect();
  try {
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      previousMigration,
    );
    await seedOwner(client, fixture.historical);
    await seedOwner(client, fixture.oldWriter);
    await seedOwner(client, fixture.canonical);

    await seedDownloadJob(client, {
      format: "mp4",
      id: fixture.historicalMp4JobId,
      owner: fixture.historical,
      providerJobId: "provider-historical-mp4",
      status: "completed",
    });
    await seedDownloadJob(client, {
      format: "m4a",
      id: fixture.historicalM4aJobId,
      owner: fixture.historical,
      providerJobId: "provider-historical-m4a",
      status: "completed",
    });
    await seedDownloadJob(client, {
      format: "mp4",
      id: fixture.mismatchedJobId,
      owner: fixture.historical,
      providerJobId: "provider-authoritative-mismatch",
      status: "completed",
    });
    await seedDownloadJob(client, {
      format: "mp4",
      id: fixture.inFlightJobId,
      owner: fixture.historical,
      providerJobId: "provider-in-flight",
      status: "materializing",
    });

    await seedFile(client, {
      contentType: "video/mp4",
      externalId: fixture.historicalMp4JobId,
      fileId: fixture.historicalMp4FileId,
      metadata: {
        provider: "socialkit",
        providerJobId: "provider-historical-mp4",
        durationSeconds: 61,
        preserved: "historical",
      },
      owner: fixture.historical,
    });
    await seedFile(client, {
      contentType: "audio/mp4",
      externalId: fixture.historicalM4aJobId,
      fileId: fixture.historicalM4aFileId,
      metadata: {
        provider: "socialkit",
        providerJobId: "provider-historical-m4a",
      },
      owner: fixture.historical,
    });
    await seedFile(client, {
      contentType: "video/mp4",
      externalId: fixture.mismatchedJobId,
      fileId: fixture.mismatchedFileId,
      metadata: {
        provider: "socialkit",
        providerJobId: "provider-lookalike-mismatch",
      },
      owner: fixture.historical,
    });
    await seedFile(client, {
      contentType: "video/mp4",
      externalId: fixture.inFlightJobId,
      fileId: fixture.inFlightFileId,
      metadata: {
        provider: "socialkit",
        providerJobId: "provider-in-flight",
        preserved: "in-flight",
      },
      owner: fixture.historical,
    });
    await seedFile(client, {
      contentType: "video/mp4",
      externalId: "ordinary-video-non-uuid",
      fileId: fixture.ordinaryVideoFileId,
      metadata: { preserved: "ordinary-upload" },
      owner: fixture.historical,
    });
    await client.query(`DELETE FROM "artifact_catalog_pending_files"`);

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      SOCIALKIT_VIDEO_ARTIFACT_MIGRATION,
    );

    const historical = await readFileStates(client, [
      fixture.historicalMp4FileId,
      fixture.historicalM4aFileId,
      fixture.mismatchedFileId,
      fixture.ordinaryVideoFileId,
      fixture.inFlightFileId,
    ]);
    assert.deepEqual(requiredFile(historical, fixture.historicalMp4JobId), {
      externalId: fixture.historicalMp4JobId,
      metadata: {
        provider: "socialkit",
        providerJobId: "provider-historical-mp4",
        durationSeconds: 61,
        preserved: "historical",
        generatedBy: VIDEO_MARKER,
      },
      pending: true,
    });
    assert.equal(
      requiredFile(historical, fixture.historicalM4aJobId).metadata.generatedBy,
      undefined,
    );
    assert.equal(
      requiredFile(historical, fixture.historicalM4aJobId).pending,
      false,
    );
    assert.equal(
      requiredFile(historical, fixture.mismatchedJobId).metadata.generatedBy,
      undefined,
    );
    assert.equal(
      requiredFile(historical, fixture.mismatchedJobId).pending,
      false,
    );
    assert.equal(
      requiredFile(historical, "ordinary-video-non-uuid").metadata.generatedBy,
      undefined,
    );
    assert.equal(
      requiredFile(historical, "ordinary-video-non-uuid").pending,
      false,
    );
    assert.deepEqual(requiredFile(historical, fixture.inFlightJobId), {
      externalId: fixture.inFlightJobId,
      metadata: {
        provider: "socialkit",
        providerJobId: "provider-in-flight",
        preserved: "in-flight",
        generatedBy: VIDEO_MARKER,
      },
      pending: true,
    });

    await seedDownloadJob(client, {
      format: "mp4",
      id: fixture.oldWriterJobId,
      owner: fixture.oldWriter,
      providerJobId: "provider-old-writer",
      status: "materializing",
    });
    await seedFile(client, {
      contentType: "video/mp4",
      externalId: fixture.oldWriterJobId,
      fileId: fixture.oldWriterFileId,
      metadata: {
        provider: "socialkit",
        providerJobId: "provider-old-writer",
        preserved: "old-writer",
      },
      owner: fixture.oldWriter,
    });
    await seedDownloadJob(client, {
      format: "mp4",
      id: fixture.canonicalJobId,
      owner: fixture.canonical,
      providerJobId: "provider-canonical",
      status: "materializing",
    });
    await seedFile(client, {
      contentType: "video/mp4",
      externalId: fixture.canonicalJobId,
      fileId: fixture.canonicalFileId,
      metadata: {
        generatedBy: VIDEO_MARKER,
        provider: "socialkit",
        providerJobId: "provider-canonical",
        preserved: "canonical",
      },
      owner: fixture.canonical,
    });
    await seedFile(client, {
      contentType: "video/mp4",
      externalId: "malformed-socialkit-job-id",
      fileId: fixture.malformedFileId,
      metadata: {
        provider: "socialkit",
        providerJobId: "provider-malformed",
        preserved: "malformed",
      },
      owner: fixture.oldWriter,
    });

    const rolling = await readFileStates(client, [
      fixture.oldWriterFileId,
      fixture.canonicalFileId,
      fixture.malformedFileId,
    ]);
    assert.deepEqual(requiredFile(rolling, fixture.oldWriterJobId), {
      externalId: fixture.oldWriterJobId,
      metadata: {
        provider: "socialkit",
        providerJobId: "provider-old-writer",
        preserved: "old-writer",
        generatedBy: VIDEO_MARKER,
      },
      pending: true,
    });
    assert.deepEqual(requiredFile(rolling, fixture.canonicalJobId), {
      externalId: fixture.canonicalJobId,
      metadata: {
        generatedBy: VIDEO_MARKER,
        provider: "socialkit",
        providerJobId: "provider-canonical",
        preserved: "canonical",
      },
      pending: true,
    });
    assert.deepEqual(requiredFile(rolling, "malformed-socialkit-job-id"), {
      externalId: "malformed-socialkit-job-id",
      metadata: {
        provider: "socialkit",
        providerJobId: "provider-malformed",
        preserved: "malformed",
      },
      pending: true,
    });

    console.log(
      "   ✅ historical and in-flight authoritative MP4 rows are marked and re-queued",
    );
    console.log(
      "   ✅ M4A, ordinary video, and identity lookalikes stay unmarked",
    );
    console.log("   ✅ old and canonical writers converge during rollout\n");
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateSocialKitVideoArtifactMigration().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
