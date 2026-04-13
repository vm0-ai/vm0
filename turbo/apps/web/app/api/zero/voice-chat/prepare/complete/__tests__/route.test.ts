import { randomUUID } from "crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  createTestRunInDb,
  insertTestVoiceChatPreparation,
  updateTestVoiceChatPreparation,
  getTestVoiceChatPreparation,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../../../src/lib/auth/sandbox-token";

const { POST } = await import("../route");

const context = testContext();

const BASE_URL = "http://localhost:3000/api/zero/voice-chat/prepare/complete";

async function setupOrg(userId: string) {
  const slug = uniqueId("zvpc");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

async function createRequestWithSandboxToken(
  userId: string,
  runId: string,
  body?: unknown,
) {
  const token = await generateSandboxToken(userId, runId);
  return createTestRequest(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("POST /api/zero/voice-chat/prepare/complete", () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const org = await setupOrg(userId);
    orgId = org.orgId;
  });

  it("should return 401 when no auth token is provided", async () => {
    const response = await POST(
      createTestRequest(BASE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "test" }),
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 400 when content is missing", async () => {
    const runId = randomUUID();
    const request = await createRequestWithSandboxToken(userId, runId, {});
    const response = await POST(request);
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should return 400 when content is empty", async () => {
    const runId = randomUUID();
    const request = await createRequestWithSandboxToken(userId, runId, {
      content: "",
    });
    const response = await POST(request);
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should return 404 when no in-flight preparation matches run", async () => {
    const runId = randomUUID();
    const request = await createRequestWithSandboxToken(userId, runId, {
      content: "test directive",
    });
    const response = await POST(request);
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("should complete preparation when in-flight preparation exists", async () => {
    const { agentId } = await createTestCompose(uniqueId("pc-ok"));
    const { runId } = await createTestRunInDb(userId, agentId);

    // Insert preparation and set its runId
    const prepId = await insertTestVoiceChatPreparation({
      orgId,
      userId,
      agentId,
      mode: "chat",
      status: "preparing",
    });

    // Set the runId on the preparation
    await updateTestVoiceChatPreparation(prepId, { runId });

    const request = await createRequestWithSandboxToken(userId, runId, {
      content: "Initial directive for the fast-brain.",
    });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.id).toBe(prepId);
    expect(body.status).toBe("ready");

    // Verify preparation was updated in the database
    const prep = await getTestVoiceChatPreparation(prepId);
    expect(prep!.status).toBe("ready");
    expect(prep!.directiveContent).toBe(
      "Initial directive for the fast-brain.",
    );
  });

  it("should not complete preparation that is already ready", async () => {
    const { agentId } = await createTestCompose(uniqueId("pc-already"));
    const { runId } = await createTestRunInDb(userId, agentId);

    const prepId = await insertTestVoiceChatPreparation({
      orgId,
      userId,
      agentId,
      mode: "chat",
      status: "ready",
      directiveContent: "Already completed.",
    });

    await updateTestVoiceChatPreparation(prepId, { runId });

    const request = await createRequestWithSandboxToken(userId, runId, {
      content: "New content that should not be written.",
    });
    const response = await POST(request);
    const body = await response.json();

    // Should return 404 since there's no "preparing" preparation for this run
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
