import { describe, it, expect, beforeEach } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
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
import { updateUserFeatureSwitches } from "../../../../../../../src/lib/zero/user/feature-switches-service";

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

  it("returns 403 when the feature switch is disabled", async () => {
    const response = await GET(
      createTestRequest(
        "http://localhost:3000/api/zero/chat-threads/thread-id/artifacts",
      ),
    );

    expect(response.status).toBe(403);
  });

  it("returns uploaded files grouped by run", async () => {
    await updateUserFeatureSwitches(testOrgId, testUserId, {
      [FeatureSwitchKey.ChatArtifactsDrawer]: true,
    });
    context.mocks.s3.listS3Objects.mockImplementation(
      async (_bucket, prefix) => {
        if (prefix.endsWith("/file-1/")) {
          return [{ key: `${prefix}data.csv`, size: 2048 }];
        }
        return [];
      },
    );

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
    });

    await insertTestChatMessage({
      chatThreadId: threadId,
      userId: testUserId,
      role: "user",
      content: "Use the attached file",
      runId,
      attachFiles: ["file-1"],
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
});
