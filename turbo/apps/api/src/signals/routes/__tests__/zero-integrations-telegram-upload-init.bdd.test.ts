import { randomUUID } from "node:crypto";

import { integrationsTelegramUploadInitContract } from "@vm0/api-contracts/contracts/integrations";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";

// BDD migration of the legacy
// `zero-integrations-telegram-upload-init.test.ts`. The 3 legacy
// `it()`s collapse into 2 BDD `it()`s: (1) 401 unauth chain,
// (2) 200 success chain (presigned URL response shape + S3
// getSignedUrl config uses the public endpoint + large payload
// (50MB+1) is not rejected before Telegram).

const context = testContext();
const store = createStore();

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: ["telegram:write"],
    iat: seconds,
    exp: seconds + 60,
  });
}

function client() {
  return setupApp({ context })(integrationsTelegramUploadInitContract);
}

const track = createFixtureTracker<OrgMembershipFixture>((fixture) => {
  return store.set(deleteOrgMembership$, fixture, context.signal);
});

describe("BDD POST /api/zero/integrations/telegram/upload-file/init — auth boundary", () => {
  it("rejects unauthenticated requests", async () => {
    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      client().init({
        body: {
          filename: "report.pdf",
          contentType: "application/pdf",
          length: 100,
        },
        headers: {},
      }),
      [401],
    );
    expect(noAuth.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("BDD POST /api/zero/integrations/telegram/upload-file/init — 200 success chain", () => {
  it("gwt-wt-wt: 200 with presigned URL + S3 public endpoint → 200 with large payload (50MB+1) passes without rejection", async () => {
    // Given: S3 endpoints configured + an org membership +
    // a sandbox token with `telegram:write` capability.
    mockEnv("S3_ENDPOINT", "http://internal-s3.test");
    mockEnv("S3_PUBLIC_ENDPOINT", "https://public-s3.test");
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    await track(
      store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    const token = zeroToken({ userId, orgId, runId });

    // When: the route signs a presigned URL.
    const response = await client().init({
      body: {
        filename: "daily report.pdf",
        contentType: "application/pdf",
        length: 1234,
      },
      headers: { authorization: `Bearer ${token}` },
    });

    // Then: 200 with the normalized response body.
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body).toMatchObject({
      filename: "daily_report.pdf",
      contentType: "application/pdf",
      size: 1234,
    });
    expect(response.body.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body.uploadUrl).toMatch(/^https?:\/\//);
    expect(response.body.fileUrl).toBe(
      `https://cdn.vm7.io/artifacts/${userId}/${response.body.uploadId}/daily_report.pdf`,
    );

    // Then: S3 `getSignedUrl` was called with the test bucket
    // and the artifact key, using the public endpoint.
    const calls = context.mocks.s3.getSignedUrl.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const cmd = calls[0]?.[1] as { input: { Bucket: string; Key: string } };
    expect(cmd.input.Bucket).toBe("test-user-artifacts");
    expect(cmd.input.Key).toBe(
      `artifacts/${userId}/${response.body.uploadId}/daily_report.pdf`,
    );
    expect(context.mocks.s3.clientConfig).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://public-s3.test" }),
    );

    // Given: a fresh org membership for a different run.
    const userId2 = `user_${randomUUID().slice(0, 8)}`;
    const orgId2 = `org_${randomUUID().slice(0, 8)}`;
    const runId2 = `run_${randomUUID()}`;
    await track(
      store.set(
        seedOrgMembership$,
        { orgId: orgId2, userId: userId2 },
        context.signal,
      ),
    );
    const token2 = zeroToken({ userId: userId2, orgId: orgId2, runId: runId2 });

    // When: a large (50MB+1) payload is sent — Telegram has
    // its own size cap; this route should not impose one.
    const large = await client().init({
      body: {
        filename: "big.bin",
        contentType: "application/octet-stream",
        length: 50 * 1024 * 1024 + 1,
      },
      headers: { authorization: `Bearer ${token2}` },
    });

    // Then: 200 with the same response shape.
    expect(large.status).toBe(200);
    if (large.status !== 200) {
      return;
    }
    expect(large.body).toMatchObject({
      filename: "big.bin",
      contentType: "application/octet-stream",
      size: 50 * 1024 * 1024 + 1,
    });
  });
});
