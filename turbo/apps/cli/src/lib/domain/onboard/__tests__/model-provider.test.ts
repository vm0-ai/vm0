import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkModelProviderStatus,
  getProviderChoices,
  checkExistingCredential,
  setupModelProvider,
} from "../model-provider.js";

vi.mock("../../../api/domains/model-providers.js", () => ({
  listModelProviders: vi.fn(),
  upsertModelProvider: vi.fn(),
  checkModelProviderCredential: vi.fn(),
  convertModelProviderCredential: vi.fn(),
}));

import {
  listModelProviders,
  upsertModelProvider,
  checkModelProviderCredential,
} from "../../../api/domains/model-providers.js";

describe("model-provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkModelProviderStatus", () => {
    it("should return hasProvider true when providers exist", async () => {
      vi.mocked(listModelProviders).mockResolvedValue({
        modelProviders: [
          {
            id: "123",
            type: "anthropic-api-key",
            framework: "claude-code",
            credentialName: "ANTHROPIC_API_KEY",
            isDefault: true,
            createdAt: "2024-01-01",
            updatedAt: "2024-01-01",
          },
        ],
      });

      const result = await checkModelProviderStatus();

      expect(result.hasProvider).toBe(true);
      expect(result.providers.length).toBe(1);
    });

    it("should return hasProvider false when no providers", async () => {
      vi.mocked(listModelProviders).mockResolvedValue({
        modelProviders: [],
      });

      const result = await checkModelProviderStatus();

      expect(result.hasProvider).toBe(false);
      expect(result.providers.length).toBe(0);
    });
  });

  describe("getProviderChoices", () => {
    it("should return all provider types", () => {
      const choices = getProviderChoices();

      expect(choices.length).toBeGreaterThan(0);
      expect(choices.some((c) => c.type === "anthropic-api-key")).toBe(true);
      expect(choices.some((c) => c.type === "claude-code-oauth-token")).toBe(
        true,
      );
    });

    it("should include label and helpText for each choice", () => {
      const choices = getProviderChoices();

      for (const choice of choices) {
        expect(choice.label).toBeDefined();
        expect(choice.helpText).toBeDefined();
        expect(choice.credentialLabel).toBeDefined();
      }
    });
  });

  describe("checkExistingCredential", () => {
    it("should return exists true when credential exists", async () => {
      vi.mocked(checkModelProviderCredential).mockResolvedValue({
        exists: true,
        credentialName: "ANTHROPIC_API_KEY",
        currentType: "user",
      });

      const result = await checkExistingCredential("anthropic-api-key");

      expect(result.exists).toBe(true);
      expect(result.credentialName).toBe("ANTHROPIC_API_KEY");
      expect(result.currentType).toBe("user");
    });

    it("should return exists false when no credential", async () => {
      vi.mocked(checkModelProviderCredential).mockResolvedValue({
        exists: false,
        credentialName: "ANTHROPIC_API_KEY",
      });

      const result = await checkExistingCredential("anthropic-api-key");

      expect(result.exists).toBe(false);
    });
  });

  describe("setupModelProvider", () => {
    it("should setup provider and return result", async () => {
      vi.mocked(upsertModelProvider).mockResolvedValue({
        provider: {
          id: "123",
          type: "anthropic-api-key",
          framework: "claude-code",
          credentialName: "ANTHROPIC_API_KEY",
          isDefault: true,
          createdAt: "2024-01-01",
          updatedAt: "2024-01-01",
        },
        created: true,
      });

      const result = await setupModelProvider(
        "anthropic-api-key",
        "test-credential",
      );

      expect(result.created).toBe(true);
      expect(result.isDefault).toBe(true);
      expect(result.framework).toBe("claude-code");
      expect(upsertModelProvider).toHaveBeenCalledWith({
        type: "anthropic-api-key",
        credential: "test-credential",
        convert: undefined,
      });
    });

    it("should pass convert option when specified", async () => {
      vi.mocked(upsertModelProvider).mockResolvedValue({
        provider: {
          id: "123",
          type: "anthropic-api-key",
          framework: "claude-code",
          credentialName: "ANTHROPIC_API_KEY",
          isDefault: true,
          createdAt: "2024-01-01",
          updatedAt: "2024-01-01",
        },
        created: false,
      });

      await setupModelProvider("anthropic-api-key", "test-credential", {
        convert: true,
      });

      expect(upsertModelProvider).toHaveBeenCalledWith({
        type: "anthropic-api-key",
        credential: "test-credential",
        convert: true,
      });
    });
  });
});
