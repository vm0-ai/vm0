import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../../app/api/zero/model-providers/route";
import {
  createTestRequest,
  createTestOrg,
  insertVm0ApiKeys,
  getTestVm0ApiKey,
  insertOrgDefaultModelProvider,
} from "./api-test-helpers";
import { testContext, uniqueId } from "./test-helpers";
import { mockClerk } from "./clerk-mock";
import {
  getVm0ConcreteProviderType,
  getVm0Vendor,
  getVm0ApiModel,
  VM0_MODEL_TO_PROVIDER,
} from "@vm0/core";
import { resolveModelProviderSecrets } from "../lib/zero/context/resolve-model-provider";

const context = testContext();

async function setupOrg(
  userId: string,
  role: "org:admin" | "org:member",
  slug?: string,
) {
  const orgSlug = slug ?? uniqueId("vm0test");
  const orgId = `org_mock_${userId}`;

  mockClerk({
    userId,
    orgId,
    orgRole: role,
    orgSlug,
    clerkOrgs: [{ id: orgId, slug: orgSlug, name: orgSlug, role }],
  });
  await createTestOrg(orgSlug);

  return { slug: orgSlug, orgId };
}

function orgUrl(): string {
  return `http://localhost:3000/api/zero/model-providers`;
}

describe("VM0 managed model provider", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("API route: org slug check", () => {
    it("should create vm0 provider for vm0 org without secret", async () => {
      const userId = uniqueId("vm0-create");
      await setupOrg(userId, "org:admin", "vm0");

      const response = await POST(
        createTestRequest(orgUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "vm0",
            selectedModel: "claude-sonnet-4-6",
          }),
        }),
      );
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.provider.type).toBe("vm0");
      expect(data.provider.framework).toBe("claude-code");
      expect(data.provider.selectedModel).toBe("claude-sonnet-4-6");
      expect(data.provider.isDefault).toBe(true);
      expect(data.created).toBe(true);
    });

    it("should create vm0 provider for any org without secret", async () => {
      const userId = uniqueId("vm0-any-org");
      await setupOrg(userId, "org:admin", "my-org");

      const response = await POST(
        createTestRequest(orgUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "vm0",
            selectedModel: "claude-opus-4-6",
          }),
        }),
      );
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.provider.type).toBe("vm0");
      expect(data.provider.selectedModel).toBe("claude-opus-4-6");
      expect(data.created).toBe(true);
    });
  });

  describe("key pool service", () => {
    it("should return a random key for a vendor with keys", async () => {
      await insertVm0ApiKeys([
        {
          vendor: "test-vendor",
          model: "test-model",
          apiKey: "sk-test-anthropic-1",
          label: "test key 1",
        },
        {
          vendor: "test-vendor",
          model: "test-model",
          apiKey: "sk-test-anthropic-2",
          label: "test key 2",
        },
      ]);

      const result = await getTestVm0ApiKey("test-vendor");
      expect(result).not.toBeNull();
      expect(result!.model).toBe("test-model");
      expect(["sk-test-anthropic-1", "sk-test-anthropic-2"]).toContain(
        result!.apiKey,
      );
    });

    it("should return null for vendor with no keys", async () => {
      const result = await getTestVm0ApiKey("nonexistent-vendor");
      expect(result).toBeNull();
    });
  });

  describe("model-to-provider mapping", () => {
    it("should resolve sonnet to anthropic-api-key", () => {
      expect(getVm0ConcreteProviderType("claude-sonnet-4-6")).toBe(
        "anthropic-api-key",
      );
      expect(getVm0Vendor("claude-sonnet-4-6")).toBe("anthropic");
    });

    it("should resolve opus to anthropic-api-key", () => {
      expect(getVm0ConcreteProviderType("claude-opus-4-6")).toBe(
        "anthropic-api-key",
      );
      expect(getVm0Vendor("claude-opus-4-6")).toBe("anthropic");
    });

    it("should resolve glm-5.1 to openrouter-api-key with z-ai/glm-5.1 upstream id", () => {
      expect(getVm0ConcreteProviderType("glm-5.1")).toBe("openrouter-api-key");
      expect(getVm0Vendor("glm-5.1")).toBe("openrouter");
      expect(getVm0ApiModel("glm-5.1")).toBe("z-ai/glm-5.1");
    });

    it("should resolve kimi-k2.6 to moonshot-api-key", () => {
      expect(getVm0ConcreteProviderType("kimi-k2.6")).toBe("moonshot-api-key");
      expect(getVm0Vendor("kimi-k2.6")).toBe("moonshot");
      expect(getVm0ApiModel("kimi-k2.6")).toBe("kimi-k2.6");
    });

    it("should fall back to display name when no apiModel override is set", () => {
      expect(getVm0ApiModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    });

    it("should throw for unknown models", () => {
      expect(() => {
        return getVm0ConcreteProviderType("unknown-model");
      }).toThrow('Unknown VM0 model "unknown-model"');
    });

    it("should throw for unknown models in getVm0ApiModel", () => {
      expect(() => {
        return getVm0ApiModel("unknown-model");
      }).toThrow('Unknown VM0 model "unknown-model"');
    });

    it("should have all VM0 provider models mapped", () => {
      expect(Object.keys(VM0_MODEL_TO_PROVIDER)).toEqual([
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "glm-5.1",
        "claude-haiku-4-5",
        "kimi-k2.6",
        "kimi-k2.5",
        "MiniMax-M2.7",
        "deepseek-chat",
      ]);
    });
  });

  describe("glm-5.1 openrouter routing integration", () => {
    it("should inject z-ai/glm-5.1 as ANTHROPIC_MODEL when resolving vm0 glm-5.1 provider", async () => {
      const userId = uniqueId("glm-route");
      const { orgId } = await setupOrg(userId, "org:admin", uniqueId("glm"));

      await insertOrgDefaultModelProvider(orgId, "vm0", "glm-5.1");
      await insertVm0ApiKeys([
        {
          vendor: "openrouter",
          model: "z-ai/glm-5.1",
          apiKey: "sk-or-v1-glmtestkey",
          label: "glm-5.1 test key",
        },
      ]);

      const result = await resolveModelProviderSecrets(
        orgId,
        "claude-code",
        false,
      );

      expect(result.resolvedModelProvider).toBe("vm0");
      expect(result.concreteProviderType).toBe("openrouter-api-key");
      expect(result.selectedModel).toBe("glm-5.1");
      // The apiModel override must flow through to ANTHROPIC_MODEL — this is the core fix
      expect(result.injectedEnvironment?.ANTHROPIC_MODEL).toBe("z-ai/glm-5.1");
      expect(result.secrets?.OPENROUTER_API_KEY).toBeDefined();
    });
  });
});
