import type { NextRequest } from "next/server";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebClient } from "@slack/web-api";
import { POST } from "../route";
import {
  createTestCompose,
  createTestRequest,
  insertOrgMembersCacheEntry,
} from "../../../../../../../../src/__tests__/api-test-helpers";
import { createTestSlackOrgInstallation } from "../../../../../../../../src/__tests__/db-test-seeders/slack";
import { seedTestRun } from "../../../../../../../../src/__tests__/db-test-seeders/runs";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../../src/__tests__/clerk-mock";
import { generateZeroToken } from "../../../../../../../../src/lib/auth/sandbox-token";
import {
  findTestRunUploadedFiles,
  findTestRunUploadedFilesByRun,
} from "../../../../../../../../src/__tests__/db-test-assertions/run-uploaded-files";

const URL =
  "http://localhost:3000/api/zero/integrations/slack/upload-file/complete";

const context = testContext();

describe("POST /api/zero/integrations/slack/upload-file/complete", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  async function zeroTokenWithRun(): Promise<{
    token: string;
    runId: string;
  }> {
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await seedTestRun(user.userId, composeId);
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    mockClerk({ userId: null });
    const token = await generateZeroToken(user.userId, runId, user.orgId);
    return { token, runId };
  }

  function completeRequest(
    body: Record<string, unknown>,
    token?: string,
  ): NextRequest {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    return createTestRequest(URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  function mockSlackFile(fileId: string): void {
    const mockClient = vi.mocked(new WebClient(""));
    vi.mocked(mockClient.files.completeUploadExternal).mockResolvedValue({
      ok: true,
    } as never);
    vi.mocked(mockClient.files.info).mockResolvedValue({
      ok: true,
      file: {
        id: fileId,
        name: "report.csv",
        title: "Slack Report",
        mimetype: "text/csv",
        filetype: "csv",
        size: 42,
        permalink: `https://slack.example/files/${fileId}`,
      },
    } as never);
  }

  it("records a Slack upload for a run-scoped zero token after Slack completion succeeds", async () => {
    const { token, runId } = await zeroTokenWithRun();
    await createTestSlackOrgInstallation({ orgId: user.orgId });
    const fileId = uniqueId("F");
    mockSlackFile(fileId);

    const response = await POST(
      completeRequest(
        {
          fileId,
          channel: "C123",
          threadTs: "123.456",
          title: "Quarterly report",
          initialComment: "Uploaded from a run",
        },
        token,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      fileId,
      permalink: `https://slack.example/files/${fileId}`,
    });

    const rows = await findTestRunUploadedFiles("slack", fileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId,
      source: "slack",
      externalId: fileId,
      userId: user.userId,
      orgId: user.orgId,
      filename: "Quarterly report",
      contentType: "text/csv",
      sizeBytes: 42,
      url: `https://slack.example/files/${fileId}`,
      metadata: {
        channel: "C123",
        threadTs: "123.456",
        title: "Quarterly report",
        initialComment: "Uploaded from a run",
        slackFile: {
          id: fileId,
          name: "report.csv",
          title: "Slack Report",
          mimetype: "text/csv",
          filetype: "csv",
        },
      },
    });
  });

  it("does not record a run association for ordinary session auth", async () => {
    await createTestSlackOrgInstallation({ orgId: user.orgId });
    const fileId = uniqueId("F");
    mockSlackFile(fileId);

    const response = await POST(
      completeRequest({
        fileId,
        channel: "C123",
        title: "Session upload",
      }),
    );

    expect(response.status).toBe(200);
    expect(await findTestRunUploadedFiles("slack", fileId)).toHaveLength(0);
  });

  it("is idempotent for repeated completion calls for the same run file", async () => {
    const { token, runId } = await zeroTokenWithRun();
    await createTestSlackOrgInstallation({ orgId: user.orgId });
    const fileId = uniqueId("F");
    mockSlackFile(fileId);

    const body = {
      fileId,
      channel: "C123",
      title: "Retry upload",
    };

    await POST(completeRequest(body, token));
    await POST(completeRequest(body, token));

    const rows = await findTestRunUploadedFilesByRun({
      runId,
      source: "slack",
      externalId: fileId,
    });
    expect(rows).toHaveLength(1);
  });
});
