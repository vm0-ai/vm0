import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET, POST } from "../route";
import {
  createTestRequest,
  consumeTestCaptureNetworkBodies,
  getTestUserPreferencesAll,
  updateTestUserPreferencesAll,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

vi.mock("@axiomhq/logging");

const context = testContext();

describe("GET /api/zero/user-preferences", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return default preferences for new user", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.timezone).toBeNull();
    expect(data.pinnedAgentIds).toEqual([]);
    expect(data.sendMode).toBe("enter");
  });

  it("should return saved timezone after update", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    // Set timezone via POST
    const postRequest = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "Asia/Shanghai" }),
      },
    );
    await POST(postRequest);

    // Get preferences
    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.timezone).toBe("Asia/Shanghai");
  });

  it("should resolve default org when no orgId in session", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
  });
});

describe("POST /api/zero/user-preferences", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "America/New_York" }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should resolve default org when no orgId in session", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "America/New_York" }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
  });

  it("should update timezone successfully", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "Europe/London" }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.timezone).toBe("Europe/London");
  });

  it("should reject invalid timezone", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "Invalid/Timezone" }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should reject empty timezone", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "" }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  it("should allow updating timezone multiple times", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    // First update
    const request1 = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "Asia/Tokyo" }),
      },
    );
    const response1 = await POST(request1);
    expect(response1.status).toBe(200);

    // Second update
    const request2 = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "America/Los_Angeles" }),
      },
    );
    const response2 = await POST(request2);
    const data2 = await response2.json();

    expect(response2.status).toBe(200);
    expect(data2.timezone).toBe("America/Los_Angeles");
  });

  it("should reject request with no preferences", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  it("should update pinnedAgentIds successfully", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinnedAgentIds: ["agent-1", "agent-2"] }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.pinnedAgentIds).toEqual(["agent-1", "agent-2"]);
  });

  it("should return empty pinnedAgentIds by default", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.pinnedAgentIds).toEqual([]);
  });

  it("should persist pinnedAgentIds across GET after POST", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    // Update pinnedAgentIds
    const postRequest = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pinnedAgentIds: ["agent-a", "agent-b", "agent-c"],
        }),
      },
    );
    await POST(postRequest);

    const getRequest = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
    );
    const response = await GET(getRequest);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.pinnedAgentIds).toEqual(["agent-a", "agent-b", "agent-c"]);
  });

  it("should accept more than 4 pinned agents", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pinnedAgentIds: ["a1", "a2", "a3", "a4", "a5"],
        }),
      },
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.pinnedAgentIds).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  it("should update pinnedAgentIds without affecting other preferences", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    // Set timezone first
    const setupReq = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "America/New_York" }),
      },
    );
    await POST(setupReq);

    // Update only pinnedAgentIds
    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinnedAgentIds: ["agent-x"] }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.pinnedAgentIds).toEqual(["agent-x"]);
    expect(data.timezone).toBe("America/New_York");
  });

  it("should update sendMode to cmd-enter", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sendMode: "cmd-enter" }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.sendMode).toBe("cmd-enter");
  });

  it("should return default sendMode for new user", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.sendMode).toBe("enter");
  });

  it("should persist sendMode across GET after POST", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    // Update sendMode
    const postRequest = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sendMode: "cmd-enter" }),
      },
    );
    await POST(postRequest);

    const getRequest = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
    );
    const response = await GET(getRequest);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.sendMode).toBe("cmd-enter");
  });

  it("should return default captureNetworkBodiesRemaining as 0", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.captureNetworkBodiesRemaining).toBe(0);
  });

  it("should set and get captureNetworkBodiesRemaining", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const postRequest = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captureNetworkBodiesRemaining: 3 }),
      },
    );
    const postResponse = await POST(postRequest);
    const postData = await postResponse.json();

    expect(postResponse.status).toBe(200);
    expect(postData.captureNetworkBodiesRemaining).toBe(3);

    const getRequest = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
    );
    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getData.captureNetworkBodiesRemaining).toBe(3);
  });

  it("should not affect other preferences when updating captureNetworkBodiesRemaining", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    // Set timezone first
    const setupReq = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "Asia/Tokyo" }),
      },
    );
    await POST(setupReq);

    // Update only captureNetworkBodiesRemaining
    const request = createTestRequest(
      "http://localhost:3000/api/zero/user-preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captureNetworkBodiesRemaining: 5 }),
      },
    );
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.captureNetworkBodiesRemaining).toBe(5);
    expect(data.timezone).toBe("Asia/Tokyo");
  });
});

describe("consumeCaptureNetworkBodies", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return false when remaining is 0", async () => {
    const user = await context.setupUser();

    const consumed = await consumeTestCaptureNetworkBodies(
      user.orgId,
      user.userId,
    );
    expect(consumed).toBe(false);
  });

  it("should decrement and return true when remaining > 0", async () => {
    const user = await context.setupUser();

    await updateTestUserPreferencesAll(user.orgId, user.userId, {
      captureNetworkBodiesRemaining: 3,
    });

    const consumed = await consumeTestCaptureNetworkBodies(
      user.orgId,
      user.userId,
    );
    expect(consumed).toBe(true);

    const prefs = await getTestUserPreferencesAll(user.orgId, user.userId);
    expect(prefs.captureNetworkBodiesRemaining).toBe(2);
  });

  it("should decrement to zero and stop", async () => {
    const user = await context.setupUser();

    await updateTestUserPreferencesAll(user.orgId, user.userId, {
      captureNetworkBodiesRemaining: 1,
    });

    const first = await consumeTestCaptureNetworkBodies(
      user.orgId,
      user.userId,
    );
    expect(first).toBe(true);

    const second = await consumeTestCaptureNetworkBodies(
      user.orgId,
      user.userId,
    );
    expect(second).toBe(false);
  });

  it("should return false for user with no preferences row", async () => {
    const consumed = await consumeTestCaptureNetworkBodies(
      "org_nonexistent",
      "user_nonexistent",
    );
    expect(consumed).toBe(false);
  });
});
