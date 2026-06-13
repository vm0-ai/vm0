import { describe, it, expect } from "vitest";
import {
  getVm0ConcreteProviderType,
  getVm0Vendor,
  getVm0ApiModel,
  VM0_MODEL_TO_PROVIDER,
} from "@vm0/api-contracts/contracts/model-providers";

describe("VM0 managed model provider", () => {
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

    it("should resolve MiniMax M3 to minimax-api-key", () => {
      expect(getVm0ConcreteProviderType("MiniMax-M3")).toBe("minimax-api-key");
      expect(getVm0Vendor("MiniMax-M3")).toBe("minimax");
      expect(getVm0ApiModel("MiniMax-M3")).toBe("MiniMax-M3");
    });

    it("should resolve DeepSeek V4 Pro to deepseek-api-key", () => {
      expect(getVm0ConcreteProviderType("deepseek-v4-pro")).toBe(
        "deepseek-api-key",
      );
      expect(getVm0Vendor("deepseek-v4-pro")).toBe("deepseek");
      expect(getVm0ApiModel("deepseek-v4-pro")).toBe("deepseek-v4-pro");
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
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "glm-5.1",
        "kimi-k2.6",
        "kimi-k2.5",
        "MiniMax-M3",
        "deepseek-v4-pro",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
      ]);
    });
  });
});
