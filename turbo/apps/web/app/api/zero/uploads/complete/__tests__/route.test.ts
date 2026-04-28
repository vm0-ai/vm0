import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestCompose,
  createTestRequest,
  insertOrgMembersCacheEntry,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
import { generateZeroToken } from "../../../../../../src/lib/auth/sandbox-token";
import {
  findTestRunUploadedFiles,
  findTestRunUploadedFilesByRun,
} from "../../../../../../src/__tests__/db-test-assertions/run-uploaded-files";

const URL = "http://localhost:3000/api/zero/uploads/complete";

const context = testContext();

describe("POST /api/zero/uploads/complete", () => {
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

  function completeRequest(body: unknown, token?: string): NextRequest {
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

  it("records a web upload for a run-scoped zero token after the object exists", async () => {
    const { token, runId } = await zeroTokenWithRun();
    const fileId = randomUUID();
    const s3Key = `uploads/${user.userId}/${fileId}/report.pdf`;

    context.mocks.s3.listS3Objects.mockResolvedValueOnce([
      { key: s3Key, size: 1234 },
    ]);

    const response = await POST(completeRequest({ id: fileId }, token));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      id: fileId,
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 1234,
    });

    const rows = await findTestRunUploadedFiles("web", fileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId,
      source: "web",
      externalId: fileId,
      userId: user.userId,
      orgId: user.orgId,
      filename: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
      url: `http://localhost:3000/f/${encodeURIComponent(user.userId)}/${fileId}/report.pdf`,
      metadata: { s3Key },
    });
  });

  it("does not record a run association for ordinary session auth", async () => {
    const fileId = randomUUID();
    const s3Key = `uploads/${user.userId}/${fileId}/plain.txt`;
    context.mocks.s3.listS3Objects.mockResolvedValueOnce([
      { key: s3Key, size: 5 },
    ]);

    const response = await POST(completeRequest({ id: fileId }));

    expect(response.status).toBe(200);
    expect(await findTestRunUploadedFiles("web", fileId)).toHaveLength(0);
  });

  it("uses the validated complete content type when provided", async () => {
    const { token } = await zeroTokenWithRun();
    const fileId = randomUUID();
    const s3Key = `uploads/${user.userId}/${fileId}/data.bin`;
    context.mocks.s3.listS3Objects.mockResolvedValueOnce([
      { key: s3Key, size: 9 },
    ]);

    const response = await POST(
      completeRequest({ id: fileId, contentType: "text/csv" }, token),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: fileId,
      filename: "data.bin",
      contentType: "text/csv",
    });
    const rows = await findTestRunUploadedFiles("web", fileId);
    expect(rows[0]).toMatchObject({ contentType: "text/csv" });
  });

  it("infers audio content type from uploaded filename", async () => {
    const { token, runId } = await zeroTokenWithRun();
    const fileId = randomUUID();
    const s3Key = `uploads/${user.userId}/${fileId}/clip.mp3`;
    context.mocks.s3.listS3Objects.mockResolvedValueOnce([
      { key: s3Key, size: 2048 },
    ]);

    const response = await POST(completeRequest({ id: fileId }, token));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: fileId,
      filename: "clip.mp3",
      contentType: "audio/mpeg",
      size: 2048,
    });
    const rows = await findTestRunUploadedFiles("web", fileId);
    expect(rows[0]).toMatchObject({
      runId,
      contentType: "audio/mpeg",
      filename: "clip.mp3",
    });
  });

  it("is idempotent for repeated completion calls for the same run file", async () => {
    const { token, runId } = await zeroTokenWithRun();
    const fileId = randomUUID();
    const s3Key = `uploads/${user.userId}/${fileId}/retry.txt`;
    context.mocks.s3.listS3Objects.mockResolvedValue([{ key: s3Key, size: 7 }]);

    await POST(completeRequest({ id: fileId }, token));
    await POST(completeRequest({ id: fileId }, token));

    const rows = await findTestRunUploadedFilesByRun({
      runId,
      source: "web",
      externalId: fileId,
    });
    expect(rows).toHaveLength(1);
  });

  it("does not record when the uploaded object cannot be found", async () => {
    const { token } = await zeroTokenWithRun();
    const fileId = randomUUID();

    const response = await POST(completeRequest({ id: fileId }, token));

    expect(response.status).toBe(404);
    expect(await findTestRunUploadedFiles("web", fileId)).toHaveLength(0);
  });
});
