import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../../app/api/zero/model-providers/route";
import {
  createTestRequest,
  createTestOrg,
  insertVm0ApiKeys,
  getTestVm0ApiKey,
} from "./api-test-helpers";
import { testContext, uniqueId } from "./test-helpers";
import { mockClerk } from "./clerk-mock";
import {
  getVm0ConcreteProviderType,
  getVm0Vendor,
  VM0_MODEL_TO_PROVIDER,
} from "@vm0/core";

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

function orgUrl(slug: string): string {
  return `http://localhost:3000/api/zero/model-providers?org=${slug}`;
}

describe("VM0 managed model provider", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("API route: org slug check", () => {
    it("should create vm0 provider for vm0 org without secret", async () => {
      const userId = uniqueId("vm0-create");
      const { slug } = await setupOrg(userId, "org:admin", "vm0");

      const response = await POST(
        createTestRequest(orgUrl(slug), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "vm0",
            selectedModel: "kimi-k2.5",
          }),
        }),
      );
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.provider.type).toBe("vm0");
      expect(data.provider.framework).toBe("claude-code");
      expect(data.provider.selectedModel).toBe("kimi-k2.5");
      expect(data.provider.isDefault).toBe(true);
      expect(data.created).toBe(true);
    });

    it("should return 403 for non-vm0 org", async () => {
      const userId = uniqueId("vm0-forbid");
      const { slug } = await setupOrg(userId, "org:admin", "my-org");

      const response = await POST(
        createTestRequest(orgUrl(slug), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "vm0",
            selectedModel: "kimi-k2.5",
          }),
        }),
      );
      expect(response.status).toBe(403);

      const data = await response.json();
      expect(data.error.code).toBe("FORBIDDEN");
    });
  });

  describe("key pool service", () => {
    it("should return a random key for a vendor with keys", async () => {
      await insertVm0ApiKeys([
        {
          vendor: "moonshot",
          model: "kimi-k2.5",
          apiKey: "sk-test-moonshot-1",
          label: "test key 1",
        },
        {
          vendor: "moonshot",
          model: "kimi-k2.5",
          apiKey: "sk-test-moonshot-2",
          label: "test key 2",
        },
      ]);

      const result = await getTestVm0ApiKey("moonshot");
      expect(result).not.toBeNull();
      expect(result!.model).toBe("kimi-k2.5");
      expect(["sk-test-moonshot-1", "sk-test-moonshot-2"]).toContain(
        result!.apiKey,
      );
    });

    it("should return null for vendor with no keys", async () => {
      const result = await getTestVm0ApiKey("nonexistent-vendor");
      expect(result).toBeNull();
    });
  });

  describe("model-to-provider mapping", () => {
    it("should resolve moonshot models to moonshot-api-key", () => {
      expect(getVm0ConcreteProviderType("kimi-k2.5")).toBe("moonshot-api-key");
      expect(getVm0Vendor("kimi-k2.5")).toBe("moonshot");
    });

    it("should resolve anthropic models to anthropic-api-key", () => {
      expect(getVm0ConcreteProviderType("claude-sonnet-4.6")).toBe(
        "anthropic-api-key",
      );
      expect(getVm0Vendor("claude-sonnet-4.6")).toBe("anthropic");
    });

    it("should resolve zai models to zai-api-key", () => {
      expect(getVm0ConcreteProviderType("glm-5")).toBe("zai-api-key");
      expect(getVm0Vendor("glm-5")).toBe("zai");
    });

    it("should resolve minimax models to minimax-api-key", () => {
      expect(getVm0ConcreteProviderType("MiniMax-M2.1")).toBe(
        "minimax-api-key",
      );
      expect(getVm0Vendor("MiniMax-M2.1")).toBe("minimax");
    });

    it("should throw for unknown models", () => {
      expect(() => getVm0ConcreteProviderType("unknown-model")).toThrow(
        'Unknown VM0 model "unknown-model"',
      );
    });

    it("should have all VM0 provider models mapped", () => {
      const vm0Models = [
        "claude-sonnet-4.6",
        "claude-opus-4.6",
        "kimi-k2.5",
        "kimi-k2-thinking-turbo",
        "kimi-k2-thinking",
        "glm-5",
        "glm-4.7",
        "glm-4.5-air",
        "MiniMax-M2.1",
      ];
      for (const model of vm0Models) {
        expect(VM0_MODEL_TO_PROVIDER[model]).toBeDefined();
      }
    });
  });
});
