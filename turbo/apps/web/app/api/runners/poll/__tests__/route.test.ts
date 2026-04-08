import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRunnerJob,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";

const OFFICIAL_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const context = testContext();

function makeRequest(
  body: Record<string, unknown>,
): ReturnType<typeof createTestRequest> {
  return createTestRequest("http://localhost:3000/api/runners/poll", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer vm0_official_${OFFICIAL_SECRET}`,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/runners/poll — heldSessions affinity", () => {
  let user: UserContext;
  let versionId: string;
  let group: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose("poll-test");
    versionId = compose.versionId;
    group = `vm0/poll-test-${randomUUID().slice(0, 8)}`;
  });

  it("returns affinity-matching job first when heldSessions provided", async () => {
    // Job-A: no session (first turn)
    await createTestRunnerJob(user.userId, versionId, group);

    // Job-B: has session-X (continuation)
    const jobB = await createTestRunnerJob(
      user.userId,
      versionId,
      group,
      undefined,
      {
        sessionId: "session-X",
      },
    );

    const response = await POST(
      makeRequest({ group, heldSessions: ["session-X"] }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.job).not.toBeNull();
    expect(data.job.runId).toBe(jobB.runId);
  });

  it("returns a job when heldSessions has no match", async () => {
    await createTestRunnerJob(user.userId, versionId, group);

    const response = await POST(
      makeRequest({ group, heldSessions: ["session-no-match"] }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.job).not.toBeNull();
  });

  it("returns a job when heldSessions is empty", async () => {
    await createTestRunnerJob(user.userId, versionId, group);

    const response = await POST(makeRequest({ group, heldSessions: [] }));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.job).not.toBeNull();
  });

  it("returns a job when heldSessions is omitted", async () => {
    await createTestRunnerJob(user.userId, versionId, group);

    const response = await POST(makeRequest({ group }));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.job).not.toBeNull();
  });

  it("returns null when no jobs exist for the group", async () => {
    const response = await POST(
      makeRequest({ group, heldSessions: ["session-X"] }),
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.job).toBeNull();
  });
});
