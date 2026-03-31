import { describe, it, expect, beforeEach, vi } from "vitest";
import { testContext } from "../../../__tests__/test-helpers";
import {
  listOrgModelProviders,
  upsertOrgModelProvider,
  upsertOrgMultiAuthModelProvider,
  deleteOrgModelProvider,
  setOrgModelProviderDefault,
  getOrgDefaultModelProvider,
} from "../model-provider-service";
import type { ModelProviderType } from "@vm0/core";

vi.mock("@axiomhq/logging");

const context = testContext();

describe("Org-level model provider service", () => {
  let orgId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    orgId = user.orgId;
  });

  describe("CRUD lifecycle", () => {
    it("should return empty list when no org providers exist", async () => {
      const providers = await listOrgModelProviders(orgId);
      expect(providers).toEqual([]);
    });

    it("should create an org provider", async () => {
      const { provider, created } = await upsertOrgModelProvider(
        orgId,
        "anthropic-api-key",
        "test-org-key",
      );

      expect(created).toBe(true);
      expect(provider.type).toBe("anthropic-api-key");
      expect(provider.framework).toBe("claude-code");
      expect(provider.secretName).toBe("ANTHROPIC_API_KEY");
      expect(provider.isDefault).toBe(true);
    });

    it("should list org providers", async () => {
      await upsertOrgModelProvider(orgId, "anthropic-api-key", "test-org-key");

      const providers = await listOrgModelProviders(orgId);
      expect(providers).toHaveLength(1);
      expect(providers[0]?.type).toBe("anthropic-api-key");
    });

    it("should update existing org provider on re-upsert", async () => {
      const { provider: first } = await upsertOrgModelProvider(
        orgId,
        "anthropic-api-key",
        "key-v1",
      );

      const { provider: second, created } = await upsertOrgModelProvider(
        orgId,
        "anthropic-api-key",
        "key-v2",
      );

      expect(created).toBe(false);
      expect(second.id).toBe(first.id);
    });

    it("should delete an org provider", async () => {
      await upsertOrgModelProvider(orgId, "anthropic-api-key", "test-key");

      await deleteOrgModelProvider(orgId, "anthropic-api-key");

      const providers = await listOrgModelProviders(orgId);
      expect(providers).toEqual([]);
    });

    it("should throw when deleting non-existent org provider", async () => {
      await expect(
        deleteOrgModelProvider(orgId, "anthropic-api-key"),
      ).rejects.toThrow('Model provider "anthropic-api-key" not found');
    });

    it("should store selectedModel", async () => {
      const { provider } = await upsertOrgModelProvider(
        orgId,
        "moonshot-api-key",
        "test-key",
        "kimi-k2.5",
      );

      expect(provider.selectedModel).toBe("kimi-k2.5");
    });
  });

  describe("org default assignment", () => {
    it("should auto-set first org provider as default", async () => {
      const { provider } = await upsertOrgModelProvider(
        orgId,
        "anthropic-api-key",
        "test-key",
      );

      expect(provider.isDefault).toBe(true);
    });

    it("should not auto-set second org provider as default for same framework", async () => {
      await upsertOrgModelProvider(orgId, "anthropic-api-key", "key-1");

      const { provider: second } = await upsertOrgModelProvider(
        orgId,
        "claude-code-oauth-token",
        "token-1",
      );

      expect(second.isDefault).toBe(false);
    });

    it("should switch org default with setOrgModelProviderDefault", async () => {
      await upsertOrgModelProvider(orgId, "anthropic-api-key", "key-1");
      await upsertOrgModelProvider(orgId, "claude-code-oauth-token", "token-1");

      const updated = await setOrgModelProviderDefault(
        orgId,
        "claude-code-oauth-token",
      );
      expect(updated.isDefault).toBe(true);

      const providers = await listOrgModelProviders(orgId);
      const anthropic = providers.find((p) => {
        return p.type === "anthropic-api-key";
      });
      const oauth = providers.find((p) => {
        return p.type === "claude-code-oauth-token";
      });
      expect(anthropic!.isDefault).toBe(false);
      expect(oauth!.isDefault).toBe(true);
    });

    it("should reassign org default on delete", async () => {
      await upsertOrgModelProvider(orgId, "anthropic-api-key", "key-1");
      await upsertOrgModelProvider(orgId, "claude-code-oauth-token", "token-1");

      await deleteOrgModelProvider(orgId, "anthropic-api-key");

      const providers = await listOrgModelProviders(orgId);
      expect(providers).toHaveLength(1);
      expect(providers[0]?.type).toBe("claude-code-oauth-token");
      expect(providers[0]?.isDefault).toBe(true);
    });

    it("should get org default provider for framework", async () => {
      await upsertOrgModelProvider(orgId, "anthropic-api-key", "test-key");

      const defaultProvider = await getOrgDefaultModelProvider(
        orgId,
        "claude-code",
      );
      expect(defaultProvider).not.toBeNull();
      expect(defaultProvider!.type).toBe("anthropic-api-key");
      expect(defaultProvider!.isDefault).toBe(true);
    });

    it("should return null when no org default exists", async () => {
      const defaultProvider = await getOrgDefaultModelProvider(
        orgId,
        "claude-code",
      );
      expect(defaultProvider).toBeNull();
    });
  });

  describe("multi-auth provider", () => {
    it("should create org-level AWS Bedrock provider", async () => {
      const { provider, created } = await upsertOrgMultiAuthModelProvider(
        orgId,
        "aws-bedrock",
        "access-keys",
        {
          AWS_ACCESS_KEY_ID: "test-access-key",
          AWS_SECRET_ACCESS_KEY: "test-secret-key",
          AWS_REGION: "us-east-1",
        },
      );

      expect(created).toBe(true);
      expect(provider.type).toBe("aws-bedrock");
      expect(provider.authMethod).toBe("access-keys");
      expect(provider.secretNames).toContain("AWS_ACCESS_KEY_ID");
      expect(provider.secretNames).toContain("AWS_SECRET_ACCESS_KEY");
      expect(provider.secretNames).toContain("AWS_REGION");
    });

    it("should reject single-secret provider type in multi-auth", async () => {
      await expect(
        upsertOrgMultiAuthModelProvider(
          orgId,
          "anthropic-api-key" as ModelProviderType,
          "api-key",
          { ANTHROPIC_API_KEY: "test" },
        ),
      ).rejects.toThrow("legacy single-secret provider");
    });
  });
});
