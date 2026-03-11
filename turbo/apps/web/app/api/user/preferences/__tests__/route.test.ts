import { describe, it, expect, beforeEach, vi } from "vitest";
import { auth, clerkClient } from "@clerk/nextjs/server";
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

    // Set orgId so the route can resolve clerkOrgId
    mockClerk({ userId: user.userId, orgId: user.clerkOrgId });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.timezone).toBeNull();
    expect(data.notifyEmail).toBe(false);
    expect(data.notifySlack).toBe(true);
  });

  it("should return saved timezone after update", async () => {
    const user = await context.setupUser();
    mockClerk({ userId: user.userId, orgId: user.clerkOrgId });

    // Set timezone via PUT (writes to DB + dual-writes to Clerk)
    const putRequest = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "Asia/Shanghai" }),
      },
    );
    await PUT(putRequest);

    // Re-mock with updated metadata to simulate Clerk having the data
    mockClerk({
      userId: user.userId,
      orgId: user.clerkOrgId,
      membershipTimezone: "Asia/Shanghai",
    });

    // Get preferences — reads from Clerk API (no JWT claims)
    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.timezone).toBe("Asia/Shanghai");
  });
});

describe("GET /api/user/preferences (JWT claims)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should read preferences from JWT claims when available", async () => {
    const user = await context.setupUser();

    mockClerk({
      userId: user.userId,
      orgId: user.clerkOrgId,
      membershipTimezone: "Asia/Tokyo",
      membershipNotifyEmail: true,
      membershipNotifySlack: false,
    });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.timezone).toBe("Asia/Tokyo");
    expect(data.notifyEmail).toBe(true);
    expect(data.notifySlack).toBe(false);
  });

  it("should fall back to Clerk API when JWT claims are missing", async () => {
    const user = await context.setupUser();

    // orgId set but no membership claims → falls back to Clerk API
    mockClerk({ userId: user.userId, orgId: user.clerkOrgId });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.timezone).toBeNull();
    expect(data.notifyEmail).toBe(false);
    expect(data.notifySlack).toBe(true);
  });

  it("should use default values for missing JWT claims", async () => {
    const user = await context.setupUser();

    // Only timezone in JWT, no notification claims
    mockClerk({
      userId: user.userId,
      orgId: user.clerkOrgId,
      membershipTimezone: "Europe/London",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.timezone).toBe("Europe/London");
    expect(data.notifyEmail).toBe(false);
    expect(data.notifySlack).toBe(true);
  });

  it("should read from Clerk API fallback with metadata values", async () => {
    const user = await context.setupUser();

    // Set membership metadata in Clerk API (also sets JWT claims)
    mockClerk({
      userId: user.userId,
      orgId: user.clerkOrgId,
      membershipTimezone: "America/Chicago",
      membershipNotifyEmail: true,
      membershipNotifySlack: false,
    });

    // Clear JWT claims so the code falls through to Clerk API path
    vi.mocked(auth).mockResolvedValue({
      userId: user.userId,
      orgId: user.clerkOrgId,
      sessionClaims: {},
    } as Awaited<ReturnType<typeof auth>>);

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.timezone).toBe("America/Chicago");
    expect(data.notifyEmail).toBe(true);
    expect(data.notifySlack).toBe(false);
  });
});

describe("GET /api/user/preferences (error paths)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should return BAD_REQUEST when no organization context is available", async () => {
    const user = await context.setupUser();

    // No orgId in session and no scopeId in auth context
    mockClerk({ userId: user.userId });

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("No organization context");
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

  it("should update timezone successfully", async () => {
    await context.setupUser();

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
    await context.setupUser();

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
    expect(data.error.message).toContain("Invalid timezone");
  });

  it("should reject empty timezone", async () => {
    await context.setupUser();

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
    await context.setupUser();

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
    await context.setupUser();

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
    await context.setupUser();

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
    await context.setupUser();

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
    await context.setupUser();

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
    await context.setupUser();

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

  it("should dual-write timezone to Clerk membership metadata", async () => {
    const user = await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "Asia/Tokyo" }),
      },
    );
    const response = await PUT(request);
    expect(response.status).toBe(200);

    const client = await vi.mocked(clerkClient)();
    expect(
      client.organizations.updateOrganizationMembershipMetadata,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.userId,
        publicMetadata: { timezone: "Asia/Tokyo" },
      }),
    );
  });

  it("should dual-write notifyEmail and notifySlack to Clerk membership metadata", async () => {
    const user = await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notifyEmail: true, notifySlack: false }),
      },
    );
    const response = await PUT(request);
    expect(response.status).toBe(200);

    const client = await vi.mocked(clerkClient)();
    expect(
      client.organizations.updateOrganizationMembershipMetadata,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.userId,
        publicMetadata: { notify_email: true, notify_slack: false },
      }),
    );
  });

  it("should reject request with no preferences", async () => {
    await context.setupUser();

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
});
