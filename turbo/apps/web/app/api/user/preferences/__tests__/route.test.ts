import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET, PUT } from "../route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

vi.mock("@axiomhq/logging");

const context = testContext();

describe("GET /api/user/preferences", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
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
      "http://localhost:3000/api/user/preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.timezone).toBeNull();
    expect(data.notifyEmail).toBe(false);
    expect(data.notifySlack).toBe(true);
    expect(data.pinnedAgentIds).toEqual([]);
    expect(data.sendMode).toBe("enter");
  });

  it("should return saved timezone after update", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    // Set timezone via PUT
    const putRequest = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "Asia/Shanghai" }),
      },
    );
    await PUT(putRequest);

    // Get preferences — reads from org_members table
    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
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
      "http://localhost:3000/api/user/preferences",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
  });
});

describe("PUT /api/user/preferences", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "America/New_York" }),
      },
    );
    const response = await PUT(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should resolve default org when no orgId in session", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "America/New_York" }),
      },
    );
    const response = await PUT(request);

    expect(response.status).toBe(200);
  });

  it("should update timezone successfully", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "Europe/London" }),
      },
    );
    const response = await PUT(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.timezone).toBe("Europe/London");
  });

  it("should reject invalid timezone", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "Invalid/Timezone" }),
      },
    );
    const response = await PUT(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should reject empty timezone", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "" }),
      },
    );
    const response = await PUT(request);

    expect(response.status).toBe(400);
  });

  it("should allow updating timezone multiple times", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    // First update
    const request1 = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "Asia/Tokyo" }),
      },
    );
    const response1 = await PUT(request1);
    expect(response1.status).toBe(200);

    // Second update
    const request2 = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "America/Los_Angeles" }),
      },
    );
    const response2 = await PUT(request2);
    const data2 = await response2.json();

    expect(response2.status).toBe(200);
    expect(data2.timezone).toBe("America/Los_Angeles");
  });

  it("should update notifyEmail to true", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notifyEmail: true }),
      },
    );
    const response = await PUT(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.notifyEmail).toBe(true);
  });

  it("should update timezone and notifyEmail together", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timezone: "Asia/Shanghai",
          notifyEmail: true,
        }),
      },
    );
    const response = await PUT(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.timezone).toBe("Asia/Shanghai");
    expect(data.notifyEmail).toBe(true);
  });

  it("should update only notifyEmail without affecting timezone", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    // Set timezone first
    const putTz = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "Europe/Berlin" }),
      },
    );
    await PUT(putTz);

    // Update only notifyEmail
    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notifyEmail: true }),
      },
    );
    const response = await PUT(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.timezone).toBe("Europe/Berlin");
    expect(data.notifyEmail).toBe(true);
  });

  it("should update notifySlack to false", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notifySlack: false }),
      },
    );
    const response = await PUT(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.notifySlack).toBe(false);
  });

  it("should update notifySlack independently without affecting other preferences", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    // Set timezone and notifyEmail first
    const setup = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "Europe/Berlin", notifyEmail: true }),
      },
    );
    await PUT(setup);

    // Update only notifySlack
    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notifySlack: false }),
      },
    );
    const response = await PUT(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.timezone).toBe("Europe/Berlin");
    expect(data.notifyEmail).toBe(true);
    expect(data.notifySlack).toBe(false);
  });

  it("should reject request with no preferences", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const response = await PUT(request);

    expect(response.status).toBe(400);
  });

  it("should update pinnedAgentIds successfully", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinnedAgentIds: ["agent-1", "agent-2"] }),
      },
    );
    const response = await PUT(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.pinnedAgentIds).toEqual(["agent-1", "agent-2"]);
  });

  it("should return empty pinnedAgentIds by default", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.pinnedAgentIds).toEqual([]);
  });

  it("should persist pinnedAgentIds across GET after PUT", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    // Update pinnedAgentIds
    const putRequest = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pinnedAgentIds: ["agent-a", "agent-b", "agent-c"],
        }),
      },
    );
    await PUT(putRequest);

    const getRequest = createTestRequest(
      "http://localhost:3000/api/user/preferences",
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
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pinnedAgentIds: ["a1", "a2", "a3", "a4", "a5"],
        }),
      },
    );
    const response = await PUT(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.pinnedAgentIds).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  it("should update pinnedAgentIds without affecting other preferences", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    // Set timezone first
    const setupReq = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "America/New_York" }),
      },
    );
    await PUT(setupReq);

    // Update only pinnedAgentIds
    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinnedAgentIds: ["agent-x"] }),
      },
    );
    const response = await PUT(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.pinnedAgentIds).toEqual(["agent-x"]);
    expect(data.timezone).toBe("America/New_York");
  });

  it("should update sendMode to cmd-enter", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sendMode: "cmd-enter" }),
      },
    );
    const response = await PUT(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.sendMode).toBe("cmd-enter");
  });

  it("should return default sendMode for new user", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.sendMode).toBe("enter");
  });

  it("should persist sendMode across GET after PUT", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.orgId });

    // Update sendMode
    const putRequest = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sendMode: "cmd-enter" }),
      },
    );
    await PUT(putRequest);

    const getRequest = createTestRequest(
      "http://localhost:3000/api/user/preferences",
    );
    const response = await GET(getRequest);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.sendMode).toBe("cmd-enter");
  });
});
