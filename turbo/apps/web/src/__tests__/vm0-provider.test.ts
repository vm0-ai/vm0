import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  insertVm0ApiKeys,
  deleteInsertedVm0ApiKeys,
  getTestVm0ApiKey,
} from "./api-test-helpers";
import { testContext, uniqueId } from "./test-helpers";
import {
  getVm0ConcreteProviderType,
  getVm0Vendor,
  getVm0ApiModel,
  VM0_MODEL_TO_PROVIDER,
} from "@vm0/api-contracts/contracts/model-providers";

const context = testContext();

describe("VM0 managed model provider", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  afterEach(async () => {
    await deleteInsertedVm0ApiKeys();
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

    it("should prefer a model-specific key when a model is provided", async () => {
      const vendor = uniqueId("test-vendor");
      await insertVm0ApiKeys([
        {
          vendor,
          model: "other-model",
          apiKey: "sk-test-other-model",
        },
        {
          vendor,
          model: "target-model",
          apiKey: "sk-test-target-model",
        },
      ]);

      const result = await getTestVm0ApiKey(vendor, "target-model");
      expect(result).toStrictEqual({
        apiKey: "sk-test-target-model",
        model: "target-model",
      });
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

    it("should resolve DeepSeek V4 models to deepseek-api-key", () => {
      expect(getVm0ConcreteProviderType("deepseek-v4-pro")).toBe(
        "deepseek-api-key",
      );
      expect(getVm0Vendor("deepseek-v4-pro")).toBe("deepseek");
      expect(getVm0ApiModel("deepseek-v4-pro")).toBe("deepseek-v4-pro");

      expect(getVm0ConcreteProviderType("deepseek-v4-flash")).toBe(
        "deepseek-api-key",
      );
      expect(getVm0Vendor("deepseek-v4-flash")).toBe("deepseek");
      expect(getVm0ApiModel("deepseek-v4-flash")).toBe("deepseek-v4-flash");
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
      expect(Object.keys(VM0_MODEL_TO_PROVIDER)).toStrictEqual([
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "glm-5.1",
        "claude-haiku-4-5",
        "kimi-k2.6",
        "kimi-k2.5",
        "MiniMax-M2.7",
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
      ]);
    });
  });
});
