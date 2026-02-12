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
    await context.setupUser();

    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.timezone).toBeNull();
    expect(data.notifyEmail).toBe(false);
  });

  it("should return saved timezone after update", async () => {
    await context.setupUser();

    // Set timezone
    const putRequest = createTestRequest(
      "http://localhost:3000/api/user/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "Asia/Shanghai" }),
      },
    );
    await PUT(putRequest);

    // Get preferences
    const request = createTestRequest(
      "http://localhost:3000/api/user/preferences",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.timezone).toBe("Asia/Shanghai");
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
