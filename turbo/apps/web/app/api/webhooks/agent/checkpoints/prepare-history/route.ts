import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { webhookCheckpointsPrepareHistoryContract } from "@vm0/core/contracts/webhooks";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { blobs } from "../../../../../../src/db/schema/blob";
import { eq, and } from "drizzle-orm";
import { preRegisterSessionHistoryBlob } from "../../../../../../src/lib/infra/session-history";
import { getSandboxAuthForRun } from "../../../../../../src/lib/auth/get-sandbox-auth";
import {
  generatePresignedPutUrl,
  s3ObjectExists,
} from "../../../../../../src/lib/infra/s3/s3-client";
import { env } from "../../../../../../src/env";
import { logger } from "../../../../../../src/lib/shared/logger";

const log = logger("webhook:checkpoints:prepare-history");

const router = tsr.router(webhookCheckpointsPrepareHistoryContract, {
  prepare: async ({ body, headers }) => {
    initServices();

    const { runId, hash, size } = body;

    // Authenticate with sandbox JWT and verify runId matches
    const auth = getSandboxAuthForRun(runId, headers.authorization);
    if (!auth) {
      return {
        status: 401 as const,
        body: {
          error: {
            message: "Not authenticated or runId mismatch",
            code: "UNAUTHORIZED",
          },
        },
      };
    }

    const { userId } = auth;

    // Verify run exists and belongs to the authenticated user
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
      .limit(1);

    if (!run) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    log.debug(
      `Preparing session history upload for run ${runId}, hash=${hash}, size=${size}`,
    );

    const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
    const s3Key = `blobs/${hash}.blob`;

    // Check if blob already exists in DB
    const [existingBlob] = await globalThis.services.db
      .select({ hash: blobs.hash })
      .from(blobs)
      .where(eq(blobs.hash, hash))
      .limit(1);

    if (existingBlob) {
      // Verify blob actually exists in S3 (DB record might be stale)
      const exists = await s3ObjectExists(bucketName, s3Key);
      if (exists) {
        log.debug(`Session history blob already exists: hash=${hash}`);
        return {
          status: 200 as const,
          body: { existing: true },
        };
      }
      log.debug(
        `Session history blob in DB but missing from S3, generating new presigned URL: hash=${hash}`,
      );
    }

    // Generate presigned PUT URL for direct S3 upload
    const presignedUrl = await generatePresignedPutUrl(
      bucketName,
      s3Key,
      "application/octet-stream",
      3600,
      true, // usePublicEndpoint for sandbox access
    );

    // Pre-register the blob record with the correct size.
    // The subsequent checkpoint call will increment refCount via registerSessionHistoryBlob.
    await preRegisterSessionHistoryBlob(hash, size);

    log.debug(`Presigned URL generated for session history: hash=${hash}`);

    return {
      status: 200 as const,
      body: {
        presignedUrl,
        existing: false,
      },
    };
  },
});

const handler = createHandler(
  webhookCheckpointsPrepareHistoryContract,
  router,
  {
    routeName: "webhooks.agent.checkpoints.prepare-history",
  },
);

export { handler as POST };
