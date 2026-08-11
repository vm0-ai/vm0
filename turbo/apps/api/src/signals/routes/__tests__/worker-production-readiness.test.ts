import { HttpResponse, http } from "msw";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { mockEnv } from "../../../lib/env";
import { runInvocation } from "../../../lib/invocation-context";
import { server } from "../../../mocks/server";
import { testContext } from "../../../__tests__/test-context";
import { workerProductionReadinessRoutes } from "../worker-production-readiness";

const context = testContext();
const CANDIDATE_ORIGIN = "https://api-worker-candidate.vm0.ai";
const PUBLIC_ORIGIN = "https://api.vm0.ai";
const WORKER_VERSION = "11111111-2222-3333-4444-555555555555";

async function accessAssertion(): Promise<string> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const issuer = "https://test.cloudflareaccess.com";
  const audience = "production-candidate-audience";
  const keyId = "production-candidate-key";
  mockEnv("CF_ACCESS_AUD", audience);
  mockEnv("CF_ACCESS_TEAM_DOMAIN", issuer);
  mockEnv(
    "CF_ACCESS_JWKS",
    JSON.stringify({
      keys: [
        {
          ...publicJwk,
          alg: "RS256",
          kid: keyId,
          use: "sig",
        },
      ],
    }),
  );
  return await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function configureProductionWorker(): void {
  mockEnv("ENV", "production");
  mockEnv("GIT_COMMIT_SHA", "a".repeat(40));
  mockEnv("AXIOM_DATASET_SUFFIX", "prod");
  mockEnv("CF_API_PUBLIC_ORIGIN", PUBLIC_ORIGIN);
  mockEnv("CF_API_PRODUCTION_CANDIDATE_ORIGIN", CANDIDATE_ORIGIN);
  mockEnv("CF_API_PRODUCTION_R2_SENTINEL_KEY", "ops/worker-ready");
}

async function requestInWorkerInvocation(
  url: string,
  headers?: Readonly<Record<string, string>>,
): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const app = createApp({
    signal: context.signal,
    routes: workerProductionReadinessRoutes,
  });
  const response = await runInvocation(
    {
      waitUntil(work) {
        pending.push(work);
      },
    },
    {
      kind: "fetch",
      requestId: "worker-readiness-test",
      workerVersion: WORKER_VERSION,
    },
    async () => {
      return await app.request(url, { headers });
    },
  );
  await Promise.allSettled(pending);
  return response;
}

describe("GET /api/internal/worker-readiness", () => {
  it("checks production Worker dependencies only on the Access-protected candidate origin", async () => {
    configureProductionWorker();
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 1 });
    const axiomEvents: unknown[] = [];
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/worker-readiness/ingest",
        async ({ request }) => {
          const events: unknown = await request.json();
          if (!Array.isArray(events)) {
            throw new Error("Expected an Axiom event array");
          }
          axiomEvents.push(...events);
          return HttpResponse.json({
            ingested: events.length,
            failed: 0,
            processedBytes: 1,
          });
        },
      ),
    );

    const response = await requestInWorkerInvocation(
      `${CANDIDATE_ORIGIN}/api/internal/worker-readiness`,
      { "cf-access-jwt-assertion": await accessAssertion() },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      ok: true,
      commitSha: "a".repeat(40),
      workerVersion: WORKER_VERSION,
      checks: {
        axiom: "ok",
        database: "ok",
        kms: "ok",
        r2: "ok",
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-vm0-api-runtime")).toBe("cloudflare-worker");
    expect(context.mocks.s3.send).toHaveBeenCalledOnce();
    expect(axiomEvents).toHaveLength(1);
    expect(axiomEvents[0]).toMatchObject({
      type: "worker_production_readiness",
      git_commit_sha: "a".repeat(40),
      worker_version: WORKER_VERSION,
    });
  });

  it("is hidden from the public production origin", async () => {
    configureProductionWorker();

    const response = await requestInWorkerInvocation(
      `${PUBLIC_ORIGIN}/api/internal/worker-readiness`,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Not found",
    });
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });
});
