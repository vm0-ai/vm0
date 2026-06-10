import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";

import { integrationsTelegramUploadInitContract } from "@vm0/api-contracts/contracts/integrations";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";

const context = testContext();

function client() {
  return setupApp({ context })(integrationsTelegramUploadInitContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly capabilities: readonly ZeroCapability[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 60,
  });
}

interface TelegramWriteAuth {
  readonly headers: { readonly authorization: string };
  readonly userId: string;
  readonly orgId: string;
}

function telegramWriteAuth(): TelegramWriteAuth {
  const userId = `user_${randomUUID().slice(0, 8)}`;
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ organization: { id: orgId }, role: "org:member" }],
  });
  const token = zeroToken({
    userId,
    orgId,
    runId: `run_${randomUUID()}`,
    capabilities: ["telegram:write"],
  });
  return { headers: { authorization: `Bearer ${token}` }, userId, orgId };
}

describe("POST /api/zero/integrations/telegram/upload-file/init BDD", () => {
  it("requires authentication and the telegram write capability", async () => {
    const unauthenticated = await accept(
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

    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const missingCapabilityToken = zeroToken({
      userId: `user_${randomUUID().slice(0, 8)}`,
      orgId: `org_${randomUUID().slice(0, 8)}`,
      runId: `run_${randomUUID()}`,
      capabilities: ["file:read"],
    });

    const missingCapability = await accept(
      client().init({
        body: {
          filename: "report.pdf",
          contentType: "application/pdf",
          length: 100,
        },
        headers: { authorization: `Bearer ${missingCapabilityToken}` },
      }),
      [403],
    );

    expect(missingCapability.body).toStrictEqual({
      error: {
        message: "Missing required capability: telegram:write",
        code: "FORBIDDEN",
      },
    });
  });

  it("creates a presigned upload URL and public artifact URL for a Telegram file", async () => {
    mockEnv("S3_ENDPOINT", "http://internal-s3.test");
    mockEnv("S3_PUBLIC_ENDPOINT", "https://public-s3.test");
    const auth = telegramWriteAuth();

    const response = await accept(
      client().init({
        body: {
          filename: "daily report.pdf",
          contentType: "application/pdf",
          length: 1234,
        },
        headers: auth.headers,
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      filename: "daily_report.pdf",
      contentType: "application/pdf",
      size: 1234,
    });
    expect(response.body.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body.uploadUrl).toMatch(/^https?:\/\//);
    expect(response.body.fileUrl).toBe(
      `https://cdn.vm7.io/artifacts/${auth.userId}/${response.body.uploadId}/daily_report.pdf`,
    );

    const calls = context.mocks.s3.getSignedUrl.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const command = calls[0]?.[1] as { input: { Bucket: string; Key: string } };
    expect(command.input.Bucket).toBe("test-user-artifacts");
    expect(command.input.Key).toBe(
      `artifacts/${auth.userId}/${response.body.uploadId}/daily_report.pdf`,
    );
    expect(context.mocks.s3.clientConfig).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://public-s3.test" }),
    );
  });

  it("rejects an invalid upload request before creating a presigned URL", async () => {
    const response = await accept(
      client().init({
        body: {
          filename: "",
          contentType: "application/pdf",
          length: 0,
        },
        headers: telegramWriteAuth().headers,
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
  });

  it("does not apply a VM0-specific size limit before Telegram fetches the file", async () => {
    const response = await accept(
      client().init({
        body: {
          filename: "big.bin",
          contentType: "application/octet-stream",
          length: 50 * 1024 * 1024 + 1,
        },
        headers: telegramWriteAuth().headers,
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      filename: "big.bin",
      contentType: "application/octet-stream",
      size: 50 * 1024 * 1024 + 1,
    });
  });
});
