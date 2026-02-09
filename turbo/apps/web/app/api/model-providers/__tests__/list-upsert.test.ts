import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET, PUT } from "../route";
import {
  createTestRequest,
  createTestModelProvider,
  listTestModelProviders,
  createTestSecret,
  listTestSecrets,
} from "../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../src/__tests__/clerk-mock";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");
vi.mock("@axiomhq/logging");

const context = testContext();

function upsertProvider(body: Record<string, unknown>) {
  return PUT(
    createTestRequest("http://localhost:3000/api/model-providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function listProviders() {
  return GET(createTestRequest("http://localhost:3000/api/model-providers"));
}

describe("GET /api/model-providers", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await listProviders();
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.message).toContain("Not authenticated");
  });

  it("should return empty list for user without providers", async () => {
    const response = await listProviders();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.modelProviders).toEqual([]);
  });

  it("should list all providers with correct fields", async () => {
    await createTestModelProvider("anthropic-api-key", "test-key");

    const response = await listProviders();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.modelProviders).toHaveLength(1);
    expect(body.modelProviders[0].type).toBe("anthropic-api-key");
    expect(body.modelProviders[0].framework).toBe("claude-code");
    expect(body.modelProviders[0].secretName).toBe("ANTHROPIC_API_KEY");
    expect(body.modelProviders[0].isDefault).toBe(true);
  });

  it("should return selectedModel in provider list", async () => {
    await createTestModelProvider("moonshot-api-key", "test-key", "kimi-k2.5");

    const response = await listProviders();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.modelProviders).toHaveLength(1);
    expect(body.modelProviders[0].selectedModel).toBe("kimi-k2.5");
  });

  it("should return null selectedModel for providers without model", async () => {
    await createTestModelProvider("anthropic-api-key", "test-key");

    const response = await listProviders();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.modelProviders[0].selectedModel).toBeNull();
  });
});

describe("PUT /api/model-providers (single-secret)", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await upsertProvider({
      type: "anthropic-api-key",
      secret: "test-key",
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.message).toContain("Not authenticated");
  });

  it("should create new provider with 201 status", async () => {
    const response = await upsertProvider({
      type: "anthropic-api-key",
      secret: "test-key",
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.created).toBe(true);
    expect(body.provider.type).toBe("anthropic-api-key");
    expect(body.provider.framework).toBe("claude-code");
    expect(body.provider.secretName).toBe("ANTHROPIC_API_KEY");
    expect(body.provider.isDefault).toBe(true);
  });

  it("should update existing provider with 200 status", async () => {
    // Create initial provider
    const createResponse = await upsertProvider({
      type: "anthropic-api-key",
      secret: "initial-key",
    });
    const createBody = await createResponse.json();

    // Update the provider
    const updateResponse = await upsertProvider({
      type: "anthropic-api-key",
      secret: "updated-key",
    });
    const updateBody = await updateResponse.json();

    expect(updateResponse.status).toBe(200);
    expect(updateBody.created).toBe(false);
    expect(updateBody.provider.id).toBe(createBody.provider.id);
  });

  it("should return 400 when user has no scope", async () => {
    mockClerk({ userId: "nonexistent-user-no-scope" });

    const response = await upsertProvider({
      type: "anthropic-api-key",
      secret: "test-key",
    });

    expect(response.status).toBe(400);
  });

  it("should set first provider as default for framework", async () => {
    const response = await upsertProvider({
      type: "anthropic-api-key",
      secret: "test-key",
    });
    const body = await response.json();

    expect(body.provider.isDefault).toBe(true);
  });

  it("should not set second provider as default for same framework", async () => {
    await createTestModelProvider("anthropic-api-key", "test-key-1");

    const response = await upsertProvider({
      type: "claude-code-oauth-token",
      secret: "test-token",
    });
    const body = await response.json();

    expect(body.provider.isDefault).toBe(false);
  });

  it("should create provider with selectedModel", async () => {
    const response = await upsertProvider({
      type: "moonshot-api-key",
      secret: "test-key",
      selectedModel: "kimi-k2.5",
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.provider.selectedModel).toBe("kimi-k2.5");
  });

  it("should update selectedModel when updating provider", async () => {
    await createTestModelProvider("moonshot-api-key", "test-key", "kimi-k2.5");

    const response = await upsertProvider({
      type: "moonshot-api-key",
      secret: "test-key",
      selectedModel: "kimi-k2-thinking-turbo",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.provider.selectedModel).toBe("kimi-k2-thinking-turbo");
  });

  it("should set selectedModel to null when not provided", async () => {
    const response = await upsertProvider({
      type: "moonshot-api-key",
      secret: "test-key",
    });
    const body = await response.json();

    expect(body.provider.selectedModel).toBeNull();
  });

  it("should allow same secret name for user and model-provider types", async () => {
    // Create a user-type secret with the same name
    await createTestSecret("ANTHROPIC_API_KEY", "user-secret-value");

    // Create model provider (creates model-provider-type secret with same name)
    await createTestModelProvider("anthropic-api-key", "provider-key");

    // Verify provider was created successfully
    const providers = await listTestModelProviders();
    expect(providers.find((p) => p.type === "anthropic-api-key")).toBeDefined();

    // Verify both secrets coexist
    const secrets = await listTestSecrets();
    const anthropicSecrets = secrets.filter(
      (s) => s.name === "ANTHROPIC_API_KEY",
    );
    expect(anthropicSecrets).toHaveLength(2);
    expect(anthropicSecrets.map((s) => s.type).sort()).toEqual([
      "model-provider",
      "user",
    ]);
  });
});
