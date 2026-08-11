import { initContract } from "@vm0/api-contracts/contracts/trpc-contract";
import { command } from "ccstate";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../../lib/db";
import { executeRawRows } from "../../lib/db-raw-rows";
import { env } from "../../lib/env";
import { currentInvocation } from "../../lib/invocation-context";
import { nowDate } from "../../lib/time";
import { workerIngressForUrl } from "../../lib/worker-ingress";
import { request$, setResHeader$ } from "../context/hono";
import { getDatasetName, ingestAxiomDirect } from "../external/axiom";
import { s3ObjectHead } from "../external/s3";
import type { RouteEntry } from "../route-entry";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "../services/crypto.utils";

const c = initContract();
const databaseReadinessRowSchema = z.object({ ready: z.literal(1) });

async function verifyKmsRoundTrip(plaintext: string): Promise<string> {
  const encrypted = await encryptStoredSecretValue(plaintext);
  return await decryptStoredSecretValue(encrypted);
}

const workerProductionReadinessContract = c.router({
  check: {
    method: "GET",
    path: "/api/internal/worker-readiness",
    responses: {
      200: z.object({
        ok: z.literal(true),
        commitSha: z.string(),
        workerVersion: z.string(),
        checks: z.object({
          axiom: z.literal("ok"),
          database: z.literal("ok"),
          kms: z.literal("ok"),
          r2: z.literal("ok"),
        }),
      }),
      404: z.object({ error: z.literal("Not found") }),
    },
  },
});

const workerProductionReadiness$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$);
    if (workerIngressForUrl(request.url) !== "production-candidate") {
      return {
        status: 404 as const,
        body: { error: "Not found" as const },
      };
    }

    const workerVersion = currentInvocation()?.metadata.workerVersion;
    if (!workerVersion) {
      throw new Error("Worker version metadata is unavailable");
    }

    set(setResHeader$, "Cache-Control", "no-store");
    const probeId = crypto.randomUUID();
    const kmsPlaintext = `worker-readiness:${probeId}`;
    const r2SentinelKey = env("CF_API_PRODUCTION_R2_SENTINEL_KEY");
    if (!r2SentinelKey) {
      throw new Error("Worker production R2 sentinel is not configured");
    }
    const [databaseRows, r2Head, kmsRoundTrip] = await Promise.all([
      executeRawRows(
        db(),
        sql`SELECT 1::integer AS "ready"`,
        databaseReadinessRowSchema,
      ),
      get(s3ObjectHead(env("R2_USER_STORAGES_BUCKET_NAME"), r2SentinelKey)),
      verifyKmsRoundTrip(kmsPlaintext),
    ]);
    signal.throwIfAborted();

    if (databaseRows.length !== 1) {
      throw new Error("Database readiness query returned an unexpected result");
    }
    if (r2Head.kind !== "found") {
      throw new Error("R2 readiness sentinel is missing");
    }
    if (kmsRoundTrip !== kmsPlaintext) {
      throw new Error("KMS readiness round trip failed");
    }

    const commitSha = env("GIT_COMMIT_SHA");
    const axiom = await ingestAxiomDirect(
      getDatasetName("worker-readiness"),
      [
        {
          _time: nowDate().toISOString(),
          type: "worker_production_readiness",
          probe_id: probeId,
          git_commit_sha: commitSha,
          worker_version: workerVersion,
        },
      ],
      signal,
    );
    if (!axiom.configured) {
      throw new Error("Axiom readiness ingest is not configured");
    }

    return {
      status: 200 as const,
      body: {
        ok: true as const,
        commitSha,
        workerVersion,
        checks: {
          axiom: "ok" as const,
          database: "ok" as const,
          kms: "ok" as const,
          r2: "ok" as const,
        },
      },
    };
  },
);

export const workerProductionReadinessRoutes: readonly RouteEntry[] = [
  {
    route: workerProductionReadinessContract.check,
    handler: workerProductionReadiness$,
  },
];
