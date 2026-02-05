/**
 * @vitest-environment node
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import {
  listModelProviders,
  checkCredentialExists,
  upsertModelProvider,
  convertCredentialToModelProvider,
  deleteModelProvider,
  setModelProviderDefault,
  updateModelProviderModel,
} from "../model-provider-service";
import { initServices } from "../../init-services";
import { modelProviders } from "../../../db/schema/model-provider";
import { secrets } from "../../../db/schema/secret";
import { scopes } from "../../../db/schema/scope";
import { eq, and } from "drizzle-orm";

describe("Model Provider Service", () => {
  const testUserId = `test-model-provider-user-${Date.now()}`;
  const testSlug = `test-mp-scope-${Date.now()}`;
  let testScopeId: string;

  beforeAll(async () => {
    initServices();

    // Create a test scope
    const [scope] = await globalThis.services.db
      .insert(scopes)
      .values({
        slug: testSlug,
        type: "personal",
        ownerId: testUserId,
      })
      .returning();

    testScopeId = scope!.id;
  });

  afterAll(async () => {
    // Cleanup test model providers and credentials
    await globalThis.services.db
      .delete(modelProviders)
      .where(eq(modelProviders.scopeId, testScopeId));
    await globalThis.services.db
      .delete(secrets)
      .where(eq(secrets.scopeId, testScopeId));
    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    // Clean up model providers and all secrets before each test
    await globalThis.services.db
      .delete(modelProviders)
      .where(eq(modelProviders.scopeId, testScopeId));
    await globalThis.services.db
      .delete(secrets)
      .where(eq(secrets.scopeId, testScopeId));
  });

  describe("listModelProviders", () => {
    it("should return empty array for user without providers", async () => {
      const result = await listModelProviders(testUserId);
      expect(result).toEqual([]);
    });

    it("should return empty array for nonexistent user", async () => {
      const result = await listModelProviders("nonexistent-user-12345");
      expect(result).toEqual([]);
    });

    it("should list all model providers for user", async () => {
      // Create a provider first
      await upsertModelProvider(
        testUserId,
        "anthropic-api-key",
        "test-api-key-123",
      );

      const result = await listModelProviders(testUserId);

      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe("anthropic-api-key");
      expect(result[0]!.framework).toBe("claude-code");
      expect(result[0]!.credentialName).toBe("ANTHROPIC_API_KEY");
      expect(result[0]!.isDefault).toBe(true); // First provider for framework is default
    });
  });

  describe("checkCredentialExists", () => {
    it("should return false for nonexistent credential", async () => {
      const result = await checkCredentialExists(
        testUserId,
        "anthropic-api-key",
      );
      expect(result.exists).toBe(false);
    });

    it("should return true for existing model-provider credential", async () => {
      // Create a model provider first
      await upsertModelProvider(
        testUserId,
        "anthropic-api-key",
        "test-api-key-123",
      );

      const result = await checkCredentialExists(
        testUserId,
        "anthropic-api-key",
      );
      expect(result.exists).toBe(true);
    });
  });

  describe("upsertModelProvider", () => {
    it("should create a new model provider", async () => {
      const { provider, created } = await upsertModelProvider(
        testUserId,
        "anthropic-api-key",
        "test-api-key-123",
      );

      expect(created).toBe(true);
      expect(provider.type).toBe("anthropic-api-key");
      expect(provider.framework).toBe("claude-code");
      expect(provider.credentialName).toBe("ANTHROPIC_API_KEY");
      expect(provider.isDefault).toBe(true); // First provider is default
    });

    it("should update existing model provider credential", async () => {
      // Create initial provider
      const { provider: initial } = await upsertModelProvider(
        testUserId,
        "anthropic-api-key",
        "initial-key",
      );

      // Update the provider
      const { provider: updated, created } = await upsertModelProvider(
        testUserId,
        "anthropic-api-key",
        "updated-key",
      );

      expect(created).toBe(false);
      expect(updated.id).toBe(initial.id);
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
        initial.updatedAt.getTime(),
      );
    });

    it("should throw BadRequestError when user has no scope", async () => {
      await expect(
        upsertModelProvider(
          "nonexistent-user-no-scope",
          "anthropic-api-key",
          "test-key",
        ),
      ).rejects.toMatchObject({ name: "BadRequestError" });
    });

    it("should set first provider as default for framework", async () => {
      const { provider } = await upsertModelProvider(
        testUserId,
        "anthropic-api-key",
        "test-key",
      );

      expect(provider.isDefault).toBe(true);
    });

    it("should not set second provider as default for same framework", async () => {
      // Create first provider (will be default)
      await upsertModelProvider(testUserId, "anthropic-api-key", "test-key-1");

      // Create second provider for same framework (should not be default)
      const { provider: second } = await upsertModelProvider(
        testUserId,
        "claude-code-oauth-token",
        "test-token",
      );

      expect(second.isDefault).toBe(false);
    });

    it("should allow same secret name for user and model-provider types", async () => {
      // Create a user secret first
      await globalThis.services.db.insert(secrets).values({
        scopeId: testScopeId,
        name: "ANTHROPIC_API_KEY",
        encryptedValue: "user-encrypted-value",
        type: "user",
      });

      // Creating model provider should NOT conflict with user secret
      const { provider, created } = await upsertModelProvider(
        testUserId,
        "anthropic-api-key",
        "provider-key",
      );

      expect(created).toBe(true);
      expect(provider.type).toBe("anthropic-api-key");

      // Verify both secrets exist with same name but different types
      const allSecrets = await globalThis.services.db
        .select()
        .from(secrets)
        .where(
          and(
            eq(secrets.scopeId, testScopeId),
            eq(secrets.name, "ANTHROPIC_API_KEY"),
          ),
        );

      expect(allSecrets).toHaveLength(2);
      expect(allSecrets.map((s) => s.type).sort()).toEqual([
        "model-provider",
        "user",
      ]);
    });
  });

  describe("convertCredentialToModelProvider (deprecated)", () => {
    it("should throw BadRequestError as conversion is no longer needed", async () => {
      // convertCredentialToModelProvider is deprecated - user and model-provider secrets are isolated by type
      await expect(convertCredentialToModelProvider()).rejects.toMatchObject({
        name: "BadRequestError",
        message: expect.stringContaining("no longer needed"),
      });
    });
  });

  describe("deleteModelProvider", () => {
    it("should delete model provider and its credential", async () => {
      // Create a provider
      await upsertModelProvider(testUserId, "anthropic-api-key", "test-key");

      // Delete it
      await deleteModelProvider(testUserId, "anthropic-api-key");

      // Verify it's gone
      const providers = await listModelProviders(testUserId);
      expect(providers).toHaveLength(0);

      // Verify model-provider credential is also gone (cascade)
      // Note: User secrets with the same name are not affected
      const [credential] = await globalThis.services.db
        .select()
        .from(secrets)
        .where(
          and(
            eq(secrets.scopeId, testScopeId),
            eq(secrets.name, "ANTHROPIC_API_KEY"),
            eq(secrets.type, "model-provider"),
          ),
        );
      expect(credential).toBeUndefined();
    });

    it("should throw NotFoundError for nonexistent provider", async () => {
      await expect(
        deleteModelProvider(testUserId, "anthropic-api-key"),
      ).rejects.toMatchObject({ name: "NotFoundError" });
    });

    it("should reassign default when deleting default provider", async () => {
      // Create two providers for same framework
      await upsertModelProvider(testUserId, "anthropic-api-key", "test-key-1");
      await upsertModelProvider(
        testUserId,
        "claude-code-oauth-token",
        "test-token",
      );

      // Verify first is default
      let providers = await listModelProviders(testUserId);
      const defaultProvider = providers.find((p) => p.isDefault);
      expect(defaultProvider!.type).toBe("anthropic-api-key");

      // Delete the default
      await deleteModelProvider(testUserId, "anthropic-api-key");

      // Verify remaining provider is now default
      providers = await listModelProviders(testUserId);
      expect(providers).toHaveLength(1);
      expect(providers[0]!.isDefault).toBe(true);
      expect(providers[0]!.type).toBe("claude-code-oauth-token");
    });
  });

  describe("upsertModelProvider with selectedModel", () => {
    it("should create provider with selectedModel", async () => {
      const { provider, created } = await upsertModelProvider(
        testUserId,
        "moonshot-api-key",
        "test-moonshot-key",
        "kimi-k2.5",
      );

      expect(created).toBe(true);
      expect(provider.type).toBe("moonshot-api-key");
      expect(provider.selectedModel).toBe("kimi-k2.5");
    });

    it("should update selectedModel when updating provider", async () => {
      // Create initial provider with one model
      await upsertModelProvider(
        testUserId,
        "moonshot-api-key",
        "test-moonshot-key",
        "kimi-k2-thinking-turbo",
      );

      // Update with different model
      const { provider, created } = await upsertModelProvider(
        testUserId,
        "moonshot-api-key",
        "test-moonshot-key",
        "kimi-k2.5",
      );

      expect(created).toBe(false);
      expect(provider.selectedModel).toBe("kimi-k2.5");
    });

    it("should set selectedModel to null when not provided", async () => {
      const { provider } = await upsertModelProvider(
        testUserId,
        "moonshot-api-key",
        "test-moonshot-key",
        undefined, // no model selected
      );

      expect(provider.selectedModel).toBeNull();
    });
  });

  describe("listModelProviders with selectedModel", () => {
    it("should return selectedModel in provider list", async () => {
      await upsertModelProvider(
        testUserId,
        "moonshot-api-key",
        "test-moonshot-key",
        "kimi-k2.5",
      );

      const result = await listModelProviders(testUserId);

      expect(result).toHaveLength(1);
      expect(result[0]!.selectedModel).toBe("kimi-k2.5");
    });

    it("should return null selectedModel for providers without model", async () => {
      await upsertModelProvider(testUserId, "anthropic-api-key", "test-key");

      const result = await listModelProviders(testUserId);

      expect(result).toHaveLength(1);
      expect(result[0]!.selectedModel).toBeNull();
    });
  });

  describe("setModelProviderDefault", () => {
    it("should set provider as default", async () => {
      // Create two providers for same framework
      await upsertModelProvider(testUserId, "anthropic-api-key", "test-key-1");
      await upsertModelProvider(
        testUserId,
        "claude-code-oauth-token",
        "test-token",
      );

      // Set second as default
      const provider = await setModelProviderDefault(
        testUserId,
        "claude-code-oauth-token",
      );

      expect(provider.isDefault).toBe(true);
      expect(provider.type).toBe("claude-code-oauth-token");

      // Verify first is no longer default
      const providers = await listModelProviders(testUserId);
      const anthropicProvider = providers.find(
        (p) => p.type === "anthropic-api-key",
      );
      expect(anthropicProvider!.isDefault).toBe(false);
    });

    it("should throw NotFoundError for nonexistent provider", async () => {
      await expect(
        setModelProviderDefault(testUserId, "anthropic-api-key"),
      ).rejects.toMatchObject({ name: "NotFoundError" });
    });

    it("should return existing default without changes", async () => {
      // Create a provider (it will be default)
      await upsertModelProvider(testUserId, "anthropic-api-key", "test-key");

      // Set it as default again (no-op)
      const provider = await setModelProviderDefault(
        testUserId,
        "anthropic-api-key",
      );

      expect(provider.isDefault).toBe(true);
    });
  });

  describe("updateModelProviderModel", () => {
    it("should update model selection without changing credential", async () => {
      // Create a provider with initial model
      await upsertModelProvider(
        testUserId,
        "moonshot-api-key",
        "test-moonshot-key",
        "kimi-k2.5",
      );

      // Update only the model
      const provider = await updateModelProviderModel(
        testUserId,
        "moonshot-api-key",
        "kimi-k2-thinking-turbo",
      );

      expect(provider.type).toBe("moonshot-api-key");
      expect(provider.selectedModel).toBe("kimi-k2-thinking-turbo");
    });

    it("should set model to null when not provided", async () => {
      // Create a provider with a model
      await upsertModelProvider(
        testUserId,
        "moonshot-api-key",
        "test-moonshot-key",
        "kimi-k2.5",
      );

      // Update without model (sets to null)
      const provider = await updateModelProviderModel(
        testUserId,
        "moonshot-api-key",
        undefined,
      );

      expect(provider.selectedModel).toBeNull();
    });

    it("should throw NotFoundError for nonexistent provider", async () => {
      await expect(
        updateModelProviderModel(testUserId, "anthropic-api-key", "model"),
      ).rejects.toMatchObject({ name: "NotFoundError" });
    });

    it("should preserve isDefault flag", async () => {
      // Create a default provider
      await upsertModelProvider(
        testUserId,
        "moonshot-api-key",
        "test-moonshot-key",
        "kimi-k2.5",
      );

      // Update model
      const provider = await updateModelProviderModel(
        testUserId,
        "moonshot-api-key",
        "kimi-k2-thinking-turbo",
      );

      expect(provider.isDefault).toBe(true);
    });
  });
});
