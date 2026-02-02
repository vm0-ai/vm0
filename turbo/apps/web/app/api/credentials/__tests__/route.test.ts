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

describe("GET /api/credentials - List Credentials", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost:3000/api/credentials");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should return empty array for user without scope", async () => {
    mockClerk({ userId: `user-no-scope-${Date.now()}` });

    const request = createTestRequest("http://localhost:3000/api/credentials");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.credentials).toEqual([]);
  });

  it("should return empty array when no credentials exist", async () => {
    await context.setupUser();

    const request = createTestRequest("http://localhost:3000/api/credentials");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.credentials).toEqual([]);
  });

  it("should list all credentials for user", async () => {
    await context.setupUser();

    // Create a credential first
    const createRequest = createTestRequest(
      "http://localhost:3000/api/credentials",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "TEST_API_KEY",
          value: "secret-value",
          description: "Test credential",
        }),
      },
    );
    await PUT(createRequest);

    // List credentials
    const request = createTestRequest("http://localhost:3000/api/credentials");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.credentials).toHaveLength(1);
    expect(data.credentials[0].name).toBe("TEST_API_KEY");
    expect(data.credentials[0].description).toBe("Test credential");
    expect(data.credentials[0]).not.toHaveProperty("value");
    expect(data.credentials[0]).not.toHaveProperty("encryptedValue");
  });

  it("should not return credentials from other users", async () => {
    // Create first user with credential
    const user1 = await context.setupUser();
    const createRequest = createTestRequest(
      "http://localhost:3000/api/credentials",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "USER1_KEY",
          value: "user1-secret",
        }),
      },
    );
    await PUT(createRequest);

    // Create second user
    await context.setupUser({ prefix: "other-user" });

    // List credentials as second user
    const request = createTestRequest("http://localhost:3000/api/credentials");
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.credentials).toEqual([]);

    // Switch back to first user and verify their credential exists
    mockClerk({ userId: user1.userId });
    const request2 = createTestRequest("http://localhost:3000/api/credentials");
    const response2 = await GET(request2);
    const data2 = await response2.json();

    expect(data2.credentials).toHaveLength(1);
    expect(data2.credentials[0].name).toBe("USER1_KEY");
  });
});

describe("PUT /api/credentials - Set Credential", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should require authentication", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest("http://localhost:3000/api/credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "TEST_KEY",
        value: "secret",
      }),
    });
    const response = await PUT(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.message).toContain("Not authenticated");
  });

  it("should require scope to be configured", async () => {
    mockClerk({ userId: `user-no-scope-${Date.now()}` });

    const request = createTestRequest("http://localhost:3000/api/credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "TEST_KEY",
        value: "secret",
      }),
    });
    const response = await PUT(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toContain("scope");
  });

  it("should create a credential successfully", async () => {
    await context.setupUser();

    const request = createTestRequest("http://localhost:3000/api/credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "MY_API_KEY",
        value: "secret-value-123",
        description: "My API key",
      }),
    });
    const response = await PUT(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.name).toBe("MY_API_KEY");
    expect(data.description).toBe("My API key");
    expect(data.id).toBeDefined();
    expect(data.createdAt).toBeDefined();
    expect(data.updatedAt).toBeDefined();
    expect(data).not.toHaveProperty("value");
    expect(data).not.toHaveProperty("encryptedValue");
  });

  it("should update existing credential", async () => {
    await context.setupUser();

    // Create initial credential
    const createRequest = createTestRequest(
      "http://localhost:3000/api/credentials",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "UPDATE_TEST_KEY",
          value: "initial-value",
          description: "Initial description",
        }),
      },
    );
    const createResponse = await PUT(createRequest);
    const createData = await createResponse.json();

    // Update the credential
    const updateRequest = createTestRequest(
      "http://localhost:3000/api/credentials",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "UPDATE_TEST_KEY",
          value: "updated-value",
          description: "Updated description",
        }),
      },
    );
    const updateResponse = await PUT(updateRequest);
    const updateData = await updateResponse.json();

    expect(updateResponse.status).toBe(200);
    expect(updateData.id).toBe(createData.id);
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
      const request = createTestRequest(
        "http://localhost:3000/api/credentials",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "",
            value: "secret",
          }),
        },
      );
      const response = await PUT(request);

      expect(response.status).toBe(400);
    });

    it("should reject lowercase names", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/credentials",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "my_api_key",
            value: "secret",
          }),
        },
      );
      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("uppercase");
    });

    it("should reject names starting with numbers", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/credentials",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "123_KEY",
            value: "secret",
          }),
        },
      );
      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.message).toContain("start with a letter");
    });

    it("should reject names with invalid characters", async () => {
      const invalidNames = ["MY-API-KEY", "MY.API.KEY", "MY API KEY"];

      for (const name of invalidNames) {
        const request = createTestRequest(
          "http://localhost:3000/api/credentials",
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name,
              value: "secret",
            }),
          },
        );
        const response = await PUT(request);

        expect(response.status).toBe(400);
      }
    });

    it("should accept valid names", async () => {
      const validNames = [
        "MY_API_KEY",
        "GITHUB_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "A",
        "A1B2C3",
        "KEY_123",
      ];

      for (const name of validNames) {
        const request = createTestRequest(
          "http://localhost:3000/api/credentials",
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name,
              value: "secret",
            }),
          },
        );
        const response = await PUT(request);

        expect(response.status).toBe(200);
      }
    });

    it("should reject missing name", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/credentials",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            value: "secret",
          }),
        },
      );
      const response = await PUT(request);

      expect(response.status).toBe(400);
    });

    it("should reject missing value", async () => {
      const request = createTestRequest(
        "http://localhost:3000/api/credentials",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "TEST_KEY",
          }),
        },
      );
      const response = await PUT(request);

      expect(response.status).toBe(400);
    });
  });
});
