import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET, PUT } from "../route";
import { createTestRequest } from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");
vi.mock("@axiomhq/logging");

const context = testContext();

describe("GET /api/variables - List Variables", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost:3000/api/variables");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return empty array for user without scope", async () => {
    mockClerk({ userId: `user-no-scope-${Date.now()}` });

    const request = createTestRequest("http://localhost:3000/api/variables");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.variables).toEqual([]);
  });

  it("should return empty array when no variables exist", async () => {
    await context.setupUser();

    const request = createTestRequest("http://localhost:3000/api/variables");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.variables).toEqual([]);
  });

  it("should list all variables for user including values", async () => {
    await context.setupUser();

    // Create a variable first
    const createRequest = createTestRequest(
      "http://localhost:3000/api/variables",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "TEST_VAR",
          value: "test-value",
          description: "Test variable",
        }),
      },
    );
    await PUT(createRequest);

    // List variables
    const request = createTestRequest("http://localhost:3000/api/variables");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.variables).toHaveLength(1);
    expect(data.variables[0].name).toBe("TEST_VAR");
    expect(data.variables[0].value).toBe("test-value");
    expect(data.variables[0].description).toBe("Test variable");
  });

  it("should not return variables from other users", async () => {
    // Create first user with variable
    const user1 = await context.setupUser();
    const createRequest = createTestRequest(
      "http://localhost:3000/api/variables",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "USER1_VAR",
          value: "user1-value",
        }),
      },
    );
    await PUT(createRequest);

    // Create second user
    await context.setupUser({ prefix: "other-user" });

    // List variables as second user
    const request = createTestRequest("http://localhost:3000/api/variables");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.variables).toEqual([]);

    // Switch back to first user and verify their variable exists
    mockClerk({ userId: user1.userId });
    const request2 = createTestRequest("http://localhost:3000/api/variables");
    const response2 = await GET(request2);
    const data2 = await response2.json();

    expect(data2.variables).toHaveLength(1);
    expect(data2.variables[0].name).toBe("USER1_VAR");
  });
});

describe("PUT /api/variables - Set Variable", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost:3000/api/variables", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "TEST_VAR",
        value: "value",
      }),
    });
    const response = await PUT(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should require scope to be configured", async () => {
    mockClerk({ userId: `user-no-scope-${Date.now()}` });

    const request = createTestRequest("http://localhost:3000/api/variables", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "TEST_VAR",
        value: "value",
      }),
    });
    const response = await PUT(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("scope");
  });

  it("should create a variable successfully", async () => {
    await context.setupUser();

    const request = createTestRequest("http://localhost:3000/api/variables", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "MY_VAR",
        value: "my-value-123",
        description: "My variable",
      }),
    });
    const response = await PUT(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.name).toBe("MY_VAR");
    expect(data.value).toBe("my-value-123");
    expect(data.description).toBe("My variable");
    expect(data.id).toBeDefined();
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
  });

  it("should update existing variable", async () => {
    await context.setupUser();

    // Create initial variable
    const createRequest = createTestRequest(
      "http://localhost:3000/api/variables",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "UPDATE_TEST_VAR",
          value: "initial-value",
          description: "Initial description",
        }),
      },
    );
    const createResponse = await PUT(createRequest);
    const createData = await createResponse.json();

    // Update the variable
    const updateRequest = createTestRequest(
      "http://localhost:3000/api/variables",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "UPDATE_TEST_VAR",
          value: "updated-value",
          description: "Updated description",
        }),
      },
    );
    const updateResponse = await PUT(updateRequest);
    const updateData = await updateResponse.json();

    expect(updateResponse.status).toBe(200);
    expect(updateData.id).toBe(createData.id);
    expect(updateData.value).toBe("updated-value");
    expect(updateData.description).toBe("Updated description");
    expect(new Date(updateData.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(createData.updatedAt).getTime(),
    );
  });

  describe("Validation", () => {
    beforeEach(async () => {
      await context.setupUser();
    });

    it("should reject empty name", async () => {
      const request = createTestRequest("http://localhost:3000/api/variables", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "",
          value: "value",
        }),
      });
      const response = await PUT(request);

      expect(response.status).toBe(400);
    });

    it("should reject lowercase names", async () => {
      const request = createTestRequest("http://localhost:3000/api/variables", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "my_var",
          value: "value",
        }),
      });
      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("uppercase");
    });

    it("should reject names starting with numbers", async () => {
      const request = createTestRequest("http://localhost:3000/api/variables", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "123_VAR",
          value: "value",
        }),
      });
      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("start with a letter");
    });

    it("should reject missing name", async () => {
      const request = createTestRequest("http://localhost:3000/api/variables", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value: "value",
        }),
      });
      const response = await PUT(request);

      expect(response.status).toBe(400);
    });

    it("should reject missing value", async () => {
      const request = createTestRequest("http://localhost:3000/api/variables", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "TEST_VAR",
        }),
      });
      const response = await PUT(request);

      expect(response.status).toBe(400);
    });
  });
});
