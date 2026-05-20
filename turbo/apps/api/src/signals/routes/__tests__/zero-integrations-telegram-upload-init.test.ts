import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { integrationsTelegramUploadInitContract } from "@vm0/api-contracts/contracts/integrations";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";

const context = testContext();
const store = createStore();
createZeroRouteMocks(context);

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

describe("POST /api/zero/integrations/telegram/upload-file/init", () => {
  const track = createFixtureTracker<OrgMembershipFixture>((fixture) => {
    return store.set(deleteOrgMembership$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(
      integrationsTelegramUploadInitContract,
    );
    const response = await accept(
      client.init({
        body: {
          filename: "report.pdf",
          contentType: "application/pdf",
          length: 100,
        },
        headers: {},
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns a presigned upload URL and final file URL", async () => {
    mockEnv("S3_ENDPOINT", "http://internal-s3.test");
    mockEnv("S3_PUBLIC_ENDPOINT", "https://public-s3.test");
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    await track(
      store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    const token = zeroToken({ userId, orgId, runId });

    const client = setupApp({ context })(
      integrationsTelegramUploadInitContract,
    );
    const response = await client.init({
      body: {
        filename: "daily report.pdf",
        contentType: "application/pdf",
        length: 1234,
      },
      headers: { authorization: `Bearer ${token}` },
    });
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
  });

  it("does not apply a VM0-specific size limit before Telegram", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    await track(
      store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    const token = zeroToken({ userId, orgId, runId });

    const client = setupApp({ context })(
      integrationsTelegramUploadInitContract,
    );
    const response = await client.init({
      body: {
        filename: "big.bin",
        contentType: "application/octet-stream",
        length: 50 * 1024 * 1024 + 1,
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body).toMatchObject({
      filename: "big.bin",
      contentType: "application/octet-stream",
      size: 50 * 1024 * 1024 + 1,
    });
  });
});
