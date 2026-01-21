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
} from "../model-provider-service";
import { initServices } from "../../init-services";
import { modelProviders } from "../../../db/schema/model-provider";
import { credentials } from "../../../db/schema/credential";
import { scopes } from "../../../db/schema/scope";
import { eq, and } from "drizzle-orm";
import { BadRequestError, NotFoundError } from "../../errors";

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
      .delete(credentials)
      .where(eq(credentials.scopeId, testScopeId));
    await globalThis.services.db
      .delete(scopes)
      .where(eq(scopes.id, testScopeId));
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    // Clean up model providers and model-provider credentials before each test
    await globalThis.services.db
      .delete(modelProviders)
      .where(eq(modelProviders.scopeId, testScopeId));
    await globalThis.services.db
      .delete(credentials)
      .where(
        and(
          eq(credentials.scopeId, testScopeId),
          eq(credentials.type, "model-provider"),
        ),
      );
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
      expect(result.currentType).toBeUndefined();
    });

    it("should return true with type for existing model-provider credential", async () => {
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
      expect(result.currentType).toBe("model-provider");
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
      ).rejects.toThrow(BadRequestError);
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

    it("should set first provider for different framework as default", async () => {
      // Create provider for claude-code framework
      await upsertModelProvider(testUserId, "anthropic-api-key", "test-key-1");

      // Create provider for codex framework (should be default for codex)
      const { provider: codexProvider } = await upsertModelProvider(
        testUserId,
        "openai-api-key",
        "test-key-2",
      );

      expect(codexProvider.isDefault).toBe(true);
    });
  });

  describe("convertCredentialToModelProvider", () => {
    it("should convert user credential to model provider", async () => {
      // Create a user credential directly
      await globalThis.services.db.insert(credentials).values({
        scopeId: testScopeId,
        name: "ANTHROPIC_API_KEY",
        encryptedValue: "encrypted-value",
        type: "user",
      });

      const provider = await convertCredentialToModelProvider(
        testUserId,
        "anthropic-api-key",
      );

      expect(provider.type).toBe("anthropic-api-key");
      expect(provider.framework).toBe("claude-code");
      expect(provider.isDefault).toBe(true);

      // Verify credential type was updated
      const [credential] = await globalThis.services.db
        .select()
        .from(credentials)
        .where(
          and(
            eq(credentials.scopeId, testScopeId),
            eq(credentials.name, "ANTHROPIC_API_KEY"),
          ),
        );

      expect(credential!.type).toBe("model-provider");
    });

    it("should throw NotFoundError for nonexistent credential", async () => {
      await expect(
        convertCredentialToModelProvider(testUserId, "anthropic-api-key"),
      ).rejects.toThrow(NotFoundError);
    });

    it("should throw BadRequestError if credential is already model-provider", async () => {
      // Create a model provider first
      await upsertModelProvider(testUserId, "anthropic-api-key", "test-key");

      await expect(
        convertCredentialToModelProvider(testUserId, "anthropic-api-key"),
      ).rejects.toThrow(BadRequestError);
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

      // Verify credential is also gone (cascade)
      const [credential] = await globalThis.services.db
        .select()
        .from(credentials)
        .where(
          and(
            eq(credentials.scopeId, testScopeId),
            eq(credentials.name, "ANTHROPIC_API_KEY"),
          ),
        );
      expect(credential).toBeUndefined();
    });

    it("should throw NotFoundError for nonexistent provider", async () => {
      await expect(
        deleteModelProvider(testUserId, "anthropic-api-key"),
      ).rejects.toThrow(NotFoundError);
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
      ).rejects.toThrow(NotFoundError);
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

    it("should only affect providers of the same framework", async () => {
      // Create providers for different frameworks
      await upsertModelProvider(testUserId, "anthropic-api-key", "test-key-1");
      await upsertModelProvider(testUserId, "openai-api-key", "test-key-2");

      // Verify both are defaults for their respective frameworks
      const providers = await listModelProviders(testUserId);
      expect(providers.every((p) => p.isDefault)).toBe(true);

      // Create another claude-code provider
      await upsertModelProvider(
        testUserId,
        "claude-code-oauth-token",
        "test-token",
      );

      // Set it as default
      await setModelProviderDefault(testUserId, "claude-code-oauth-token");

      // Verify openai is still default
      const updatedProviders = await listModelProviders(testUserId);
      const openaiProvider = updatedProviders.find(
        (p) => p.type === "openai-api-key",
      );
      expect(openaiProvider!.isDefault).toBe(true);
    });
  });
});
