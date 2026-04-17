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

    it("should throw for unknown models", () => {
      expect(() => {
        return getVm0ConcreteProviderType("unknown-model");
      }).toThrow('Unknown VM0 model "unknown-model"');
    });

    it("should have all VM0 provider models mapped", () => {
      const vm0Models = [
        "claude-sonnet-4-6",
        "claude-opus-4-6",
        "claude-opus-4-7",
      ];
      for (const model of vm0Models) {
        expect(VM0_MODEL_TO_PROVIDER[model]).toBeDefined();
      }
      expect(Object.keys(VM0_MODEL_TO_PROVIDER)).toHaveLength(3);
    });
  });
});
