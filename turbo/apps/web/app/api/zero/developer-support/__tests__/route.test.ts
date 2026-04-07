import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRunInDb,
  insertOrgMembersCacheEntry,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { generateZeroToken } from "../../../../../src/lib/auth/sandbox-token";

const URL = "http://localhost:3000/api/zero/developer-support";

const context = testContext();

async function setupRunContext(
  user: UserContext,
  options?: { continuedFromSessionId?: string | null },
) {
  const sessionId =
    options?.continuedFromSessionId === undefined
      ? crypto.randomUUID()
      : options.continuedFromSessionId;
  const { composeId } = await createTestCompose(uniqueId("agent"));
  const { runId } = await createTestRunInDb(user.userId, composeId, {
    status: "running",
    ...(sessionId ? { continuedFromSessionId: sessionId } : {}),
  });
  await insertOrgMembersCacheEntry({
    orgId: user.orgId,
    userId: user.userId,
    role: "admin",
  });
  mockClerk({ userId: null });
  const token = await generateZeroToken(user.userId, runId, user.orgId);
  return { token, runId, composeId, sessionId };
}

function postDeveloperSupport(body: Record<string, unknown>, token: string) {
  return POST(
    createTestRequest(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/zero/developer-support", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("returns consent code when consentCode is not provided", async () => {
    const { token } = await setupRunContext(user);

    const response = await postDeveloperSupport(
      { title: "Bug report", description: "Something is broken" },
      token,
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.consentCode).toBeDefined();
    expect(data.consentCode).toHaveLength(4);
    expect(data.consentCode).toMatch(/^[0-9A-F]{4}$/);
  });

  it("returns the same consent code for the same session (deterministic)", async () => {
    const { token } = await setupRunContext(user);

    const response1 = await postDeveloperSupport(
      { title: "Bug", description: "Desc" },
      token,
    );
    const response2 = await postDeveloperSupport(
      { title: "Bug", description: "Desc" },
      token,
    );

    const data1 = await response1.json();
    const data2 = await response2.json();
    expect(data1.consentCode).toBe(data2.consentCode);
  });

  it("generates the same consent code for different runs with the same sessionId", async () => {
    const sessionId = crypto.randomUUID();
    // Create both composes and runs before mocking Clerk (mockClerk in
    // setupRunContext sets userId to null, which breaks createTestCompose)
    const { composeId: composeId1 } = await createTestCompose(
      uniqueId("agent"),
    );
    const { composeId: composeId2 } = await createTestCompose(
      uniqueId("agent"),
    );
    const { runId: runId1 } = await createTestRunInDb(user.userId, composeId1, {
      status: "running",
      continuedFromSessionId: sessionId,
    });
    const { runId: runId2 } = await createTestRunInDb(user.userId, composeId2, {
      status: "running",
      continuedFromSessionId: sessionId,
    });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    mockClerk({ userId: null });
    const token1 = await generateZeroToken(user.userId, runId1, user.orgId);
    const token2 = await generateZeroToken(user.userId, runId2, user.orgId);

    const res1 = await postDeveloperSupport(
      { title: "T", description: "D" },
      token1,
    );
    const res2 = await postDeveloperSupport(
      { title: "T", description: "D" },
      token2,
    );

    const data1 = await res1.json();
    const data2 = await res2.json();
    expect(data1.consentCode).toBe(data2.consentCode);
  });

  it("accepts consent code from a different run in the same session", async () => {
    const sessionId = crypto.randomUUID();
    const { composeId: composeId1 } = await createTestCompose(
      uniqueId("agent"),
    );
    const { composeId: composeId2 } = await createTestCompose(
      uniqueId("agent"),
    );
    const { runId: runId1 } = await createTestRunInDb(user.userId, composeId1, {
      status: "running",
      continuedFromSessionId: sessionId,
    });
    const { runId: runId2 } = await createTestRunInDb(user.userId, composeId2, {
      status: "running",
      continuedFromSessionId: sessionId,
    });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    mockClerk({ userId: null });
    const token1 = await generateZeroToken(user.userId, runId1, user.orgId);
    const token2 = await generateZeroToken(user.userId, runId2, user.orgId);

    // Step 1: Get code from run 1
    const step1 = await postDeveloperSupport(
      { title: "Bug report", description: "Something is broken" },
      token1,
    );
    const { consentCode } = await step1.json();

    // Step 2: Submit with code from run 2
    const step2 = await postDeveloperSupport(
      {
        title: "Bug report",
        description: "Something is broken",
        consentCode,
      },
      token2,
    );
    expect(step2.status).toBe(200);
    const data = await step2.json();
    expect(data.reference).toBeDefined();
    expect(data.reference).toMatch(/^ds-[a-f0-9]{8}$/);
  });

  it("returns reference when valid consent code is provided", async () => {
    const { token } = await setupRunContext(user);

    // Step 1: Get consent code
    const step1Response = await postDeveloperSupport(
      { title: "Bug report", description: "Something is broken" },
      token,
    );
    const { consentCode } = await step1Response.json();

    // Step 2: Submit with consent code
    const step2Response = await postDeveloperSupport(
      {
        title: "Bug report",
        description: "Something is broken",
        consentCode,
      },
      token,
    );

    expect(step2Response.status).toBe(200);
    const data = await step2Response.json();
    expect(data.reference).toBeDefined();
    expect(data.reference).toMatch(/^ds-[a-f0-9]{8}$/);

    // Verify S3 upload was called
    expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("developer-support/"),
      expect.any(Buffer),
      "application/zip",
    );
  });

  it("returns 400 for invalid consent code", async () => {
    const { token } = await setupRunContext(user);

    const response = await postDeveloperSupport(
      {
        title: "Bug report",
        description: "Something is broken",
        consentCode: "ZZZZ",
      },
      token,
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("INVALID_CONSENT_CODE");
  });

  it("falls back to current runId when run has no session", async () => {
    const { token, runId } = await setupRunContext(user, {
      continuedFromSessionId: null,
    });

    // Step 1: Get consent code (uses runId as HMAC seed)
    const step1 = await postDeveloperSupport(
      { title: "Bug", description: "Desc" },
      token,
    );
    expect(step1.status).toBe(200);
    const { consentCode } = await step1.json();
    expect(consentCode).toBeDefined();

    // Step 2: Submit with consent code — should query Axiom with just current runId
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

    const step2 = await postDeveloperSupport(
      { title: "Bug", description: "Desc", consentCode },
      token,
    );
    expect(step2.status).toBe(200);
    expect((await step2.json()).reference).toBeDefined();

    // Verify Axiom was queried with the current runId only
    const aplQuery = context.mocks.axiom.queryAxiom.mock.calls[0]![0] as string;
    expect(aplQuery).toContain(runId);
  });

  it("queries Axiom for agent events from session runs", async () => {
    const { token } = await setupRunContext(user);

    // Step 1: Get consent code
    const step1 = await postDeveloperSupport(
      { title: "Bug", description: "Desc" },
      token,
    );
    const { consentCode } = await step1.json();

    // Mock Axiom to return test events
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      {
        eventType: "assistant",
        eventData: { message: "hello" },
        _time: "2024-01-01T00:00:00Z",
        sequenceNumber: 1,
      },
    ]);

    // Step 2: Submit with consent code
    const step2 = await postDeveloperSupport(
      { title: "Bug", description: "Desc", consentCode },
      token,
    );
    expect(step2.status).toBe(200);

    // Verify Axiom was queried
    expect(context.mocks.axiom.queryAxiom).toHaveBeenCalledTimes(1);
    const aplQuery = context.mocks.axiom.queryAxiom.mock.calls[0]![0] as string;
    expect(aplQuery).toContain("agent-run-events");
    expect(aplQuery).toContain("limit 2000");
  });

  it("collects events from all runs in session including first run", async () => {
    const sessionId = crypto.randomUUID();

    // Create first run (completed, has result.agentSessionId)
    const { composeId: composeId1 } = await createTestCompose(
      uniqueId("agent"),
    );
    const { runId: firstRunId } = await createTestRunInDb(
      user.userId,
      composeId1,
      {
        status: "completed",
        result: {
          agentSessionId: sessionId,
          checkpointId: "cp-1",
          conversationId: "cv-1",
        },
      },
    );

    // Create continuation run (the current run)
    const { composeId: composeId2 } = await createTestCompose(
      uniqueId("agent"),
    );
    const { runId: currentRunId } = await createTestRunInDb(
      user.userId,
      composeId2,
      {
        status: "running",
        continuedFromSessionId: sessionId,
      },
    );

    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: user.userId,
      role: "admin",
    });
    mockClerk({ userId: null });
    const token = await generateZeroToken(
      user.userId,
      currentRunId,
      user.orgId,
    );

    // Get consent code and submit
    const step1 = await postDeveloperSupport(
      { title: "Bug", description: "Desc" },
      token,
    );
    const { consentCode } = await step1.json();

    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      { eventType: "assistant", eventData: {}, sequenceNumber: 1 },
    ]);

    await postDeveloperSupport(
      { title: "Bug", description: "Desc", consentCode },
      token,
    );

    // Verify APL contains both run IDs
    const aplQuery = context.mocks.axiom.queryAxiom.mock.calls[0]![0] as string;
    expect(aplQuery).toContain(firstRunId);
    expect(aplQuery).toContain(currentRunId);
  });

  it("creates bundle with empty events when Axiom query fails", async () => {
    const { token } = await setupRunContext(user);

    const step1 = await postDeveloperSupport(
      { title: "Bug", description: "Desc" },
      token,
    );
    const { consentCode } = await step1.json();

    context.mocks.axiom.queryAxiom.mockRejectedValueOnce(
      new Error("Axiom down"),
    );

    const step2 = await postDeveloperSupport(
      { title: "Bug", description: "Desc", consentCode },
      token,
    );
    expect(step2.status).toBe(200);
    expect((await step2.json()).reference).toBeDefined();
  });

  it("returns 403 when token lacks runId and orgId", async () => {
    const response = await POST(
      createTestRequest(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Bug",
          description: "Desc",
        }),
      }),
    );

    expect(response.status).toBe(403);
  });
});
