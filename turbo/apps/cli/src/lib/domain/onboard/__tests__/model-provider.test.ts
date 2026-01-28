import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server.js";
import {
  checkModelProviderStatus,
  getProviderChoices,
  checkExistingCredential,
  setupModelProvider,
} from "../model-provider.js";

describe("model-provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VM0_TOKEN", "test-token");
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("checkModelProviderStatus", () => {
    it("should return hasProvider true when providers exist", async () => {
      server.use(
        http.get("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json({
            modelProviders: [
              {
                id: "123",
                type: "anthropic-api-key",
                framework: "claude-code",
                credentialName: "ANTHROPIC_API_KEY",
                isDefault: true,
                createdAt: "2024-01-01T00:00:00Z",
                updatedAt: "2024-01-01T00:00:00Z",
              },
            ],
          });
        }),
      );

      const result = await checkModelProviderStatus();

      expect(result.hasProvider).toBe(true);
      expect(result.providers.length).toBe(1);
      expect(result.providers[0]?.type).toBe("anthropic-api-key");
    });

    it("should return hasProvider false when no providers", async () => {
      server.use(
        http.get("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json({ modelProviders: [] });
        }),
      );

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
      server.use(
        http.get(
          "http://localhost:3000/api/model-providers/check/:type",
          () => {
            return HttpResponse.json({
              exists: true,
              credentialName: "ANTHROPIC_API_KEY",
              currentType: "user",
            });
          },
        ),
      );

      const result = await checkExistingCredential("anthropic-api-key");

      expect(result.exists).toBe(true);
      expect(result.credentialName).toBe("ANTHROPIC_API_KEY");
      expect(result.currentType).toBe("user");
    });

    it("should return exists false when no credential", async () => {
      server.use(
        http.get(
          "http://localhost:3000/api/model-providers/check/:type",
          () => {
            return HttpResponse.json({
              exists: false,
              credentialName: "ANTHROPIC_API_KEY",
            });
          },
        ),
      );

      const result = await checkExistingCredential("anthropic-api-key");

      expect(result.exists).toBe(false);
    });
  });

  describe("setupModelProvider", () => {
    it("should setup provider and return result", async () => {
      server.use(
        http.put("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json({
            provider: {
              id: "123",
              type: "anthropic-api-key",
              framework: "claude-code",
              credentialName: "ANTHROPIC_API_KEY",
              isDefault: true,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
            created: true,
          });
        }),
      );

      const result = await setupModelProvider(
        "anthropic-api-key",
        "test-credential",
      );

      expect(result.created).toBe(true);
      expect(result.isDefault).toBe(true);
      expect(result.framework).toBe("claude-code");
    });

    it("should return created false when updating existing provider", async () => {
      server.use(
        http.put("http://localhost:3000/api/model-providers", () => {
          return HttpResponse.json({
            provider: {
              id: "123",
              type: "anthropic-api-key",
              framework: "claude-code",
              credentialName: "ANTHROPIC_API_KEY",
              isDefault: true,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:00:00Z",
            },
            created: false,
          });
        }),
      );

      const result = await setupModelProvider(
        "anthropic-api-key",
        "test-credential",
        { convert: true },
      );

      expect(result.created).toBe(false);
    });
  });
});
