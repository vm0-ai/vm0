import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import { POST } from "../../../route";
import {
  createTestCompose,
  createTestRequest,
  insertTestChatMessage,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { seedTestRun } from "../../../../../../../src/__tests__/db-test-seeders/runs";
import { recordRunUploadedFile } from "../../../../../../../src/lib/zero/uploads/run-uploaded-files";

const context = testContext();

describe("GET /api/zero/chat-threads/:threadId/artifacts", () => {
  let testComposeId: string;
  let testUserId: string;
  let testOrgId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    testUserId = user.userId;
    testOrgId = user.orgId;

    const { composeId } = await createTestCompose(uniqueId("artifacts"));
    testComposeId = composeId;
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(
      createTestRequest(
        "http://localhost:3000/api/zero/chat-threads/thread-id/artifacts",
      ),
    );

    expect(response.status).toBe(401);
  });

  it("returns run uploaded files grouped by run", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();
    const { runId } = await seedTestRun(testUserId, testComposeId, {
      status: "completed",
      prompt: "Use the attached file",
      chatThreadId: threadId,
    });

    await recordRunUploadedFile({
      runId,
      source: "web",
      externalId: "file-1",
      userId: testUserId,
      orgId: testOrgId,
      filename: "data.csv",
      contentType: "text/csv",
      sizeBytes: 2048,
      url: `http://localhost:3000/f/${testUserId}/file-1/data.csv`,
    });

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/artifacts`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].runId).toBe(runId);
    expect(data.runs[0].files[0]).toMatchObject({
      id: "file-1",
      filename: "data.csv",
      contentType: "text/csv",
      size: 2048,
    });
    expect(data.runs[0].files[0].url).toContain("/f/");
  });

  it("uses chat message run ownership when zero run chat thread is missing", async () => {
    const createRes = await POST(
      createTestRequest("http://localhost:3000/api/zero/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: testComposeId }),
      }),
    );
    const { id: threadId } = await createRes.json();
    const { runId } = await seedTestRun(testUserId, testComposeId, {
      status: "completed",
      prompt: "Uploaded during the run",
    });

    await insertTestChatMessage({
      chatThreadId: threadId,
      userId: testUserId,
      role: "user",
      content: "Uploaded during the run",
      runId,
    });
    await recordRunUploadedFile({
      runId,
      source: "web",
      externalId: "file-fallback",
      userId: testUserId,
      orgId: testOrgId,
      filename: "preview.html",
      contentType: "text/html",
      sizeBytes: 512,
      url: `http://localhost:3000/f/${testUserId}/file-fallback/preview.html`,
    });

    const response = await GET(
      createTestRequest(
        `http://localhost:3000/api/zero/chat-threads/${threadId}/artifacts`,
      ),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].runId).toBe(runId);
    expect(data.runs[0].files[0]).toMatchObject({
      id: "file-fallback",
      filename: "preview.html",
      contentType: "text/html",
      size: 512,
    });
  });
});
