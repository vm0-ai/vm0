import { describe, it, expect, beforeEach, vi } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { GET, POST } from "../route";
import { DELETE } from "../[type]/route";
import { POST as setDefaultPOST } from "../[type]/default/route";
import { createTestRequest } from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import type { ModelProviderType } from "@vm0/api-contracts/contracts/model-providers";

vi.mock("@vm0/core/feature-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vm0/core/feature-switch")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { isFeatureEnabled } = await import("@vm0/core/feature-switch");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

const context = testContext();

const BASE_URL = "http://localhost:3000/api/zero/model-providers";

function listUrl(): string {
  return BASE_URL;
}

function upsertUrl(): string {
  return BASE_URL;
}

function deleteUrl(type: string): string {
  return `${BASE_URL}/${type}`;
}

function setDefaultUrl(type: string): string {
  return `${BASE_URL}/${type}/default`;
}

async function listProviders(): Promise<
  Array<{
    id: string;
    type: string;
    framework: string;
    secretName: string;
    authMethod: string | null;
    secretNames: string[] | null;
    isDefault: boolean;
    selectedModel: string | null;
  }>
> {
  const request = createTestRequest(listUrl());
  const response = await GET(request);
  const data = await response.json();
  return data.modelProviders;
}

async function createProvider(
  type: string,
  secret: string,
  selectedModel?: string,
) {
  const request = createTestRequest(upsertUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, secret, selectedModel }),
  });
  return POST(request);
}

async function createMultiAuthProvider(
  type: string,
  authMethod: string,
  secrets: Record<string, string>,
  selectedModel?: string,
) {
  const request = createTestRequest(upsertUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, authMethod, secrets, selectedModel }),
  });
  return POST(request);
}

describe("Org-level model provider routes", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    void user;
  });

  // ---------------------------------------------------------------------------
  // GET /api/zero/model-providers  (list)
  // ---------------------------------------------------------------------------

  describe("GET /api/zero/model-providers", () => {
    it("should return empty list when no org providers exist", async () => {
      const request = createTestRequest(listUrl());
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.modelProviders).toEqual([]);
    });

    it("should list org providers", async () => {
      await createProvider("anthropic-api-key", "test-org-key");

      const providers = await listProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]?.type).toBe("anthropic-api-key");
    });

    it("should show first provider as default", async () => {
      await createProvider("anthropic-api-key", "test-key");

      const providers = await listProviders();
      expect(providers[0]?.isDefault).toBe(true);
    });

    it("should not show second same-framework provider as default", async () => {
      await createProvider("anthropic-api-key", "key-1");
      await createProvider("claude-code-oauth-token", "token-1");

      const providers = await listProviders();
      const anthropic = providers.find((p) => {
        return p.type === "anthropic-api-key";
      });
      const oauth = providers.find((p) => {
        return p.type === "claude-code-oauth-token";
      });
      expect(anthropic!.isDefault).toBe(true);
      expect(oauth!.isDefault).toBe(false);
    });

    it("should find default provider for framework via list", async () => {
      await createProvider("anthropic-api-key", "test-key");

      const providers = await listProviders();
      const defaultProvider = providers.find((p) => {
        return p.isDefault && p.framework === "claude-code";
      });
      expect(defaultProvider).toBeDefined();
      expect(defaultProvider!.type).toBe("anthropic-api-key");
      expect(defaultProvider!.isDefault).toBe(true);
    });

    it("should have no default for framework when no providers exist", async () => {
      const providers = await listProviders();
      const defaultProvider = providers.find((p) => {
        return p.isDefault && p.framework === "claude-code";
      });
      expect(defaultProvider).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/zero/model-providers  (upsert)
  // ---------------------------------------------------------------------------

  describe("POST /api/zero/model-providers", () => {
    it("should create an org provider", async () => {
      const response = await createProvider(
        "anthropic-api-key",
        "test-org-key",
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.created).toBe(true);
      expect(data.provider.type).toBe("anthropic-api-key");
      expect(data.provider.framework).toBe("claude-code");
      expect(data.provider.secretName).toBe("ANTHROPIC_API_KEY");
      expect(data.provider.isDefault).toBe(true);
    });

    it("should update existing org provider on re-upsert", async () => {
      const response1 = await createProvider("anthropic-api-key", "key-v1");
      const data1 = await response1.json();

      const response2 = await createProvider("anthropic-api-key", "key-v2");
      const data2 = await response2.json();

      expect(data2.created).toBe(false);
      expect(data2.provider.id).toBe(data1.provider.id);
    });

    it("should store selectedModel", async () => {
      const response = await createProvider(
        "moonshot-api-key",
        "test-key",
        "kimi-k2.5",
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.provider.selectedModel).toBe("kimi-k2.5");
    });

    it("should create org-level AWS Bedrock provider", async () => {
      const response = await createMultiAuthProvider(
        "aws-bedrock",
        "access-keys",
        {
          AWS_ACCESS_KEY_ID: "test-access-key",
          AWS_SECRET_ACCESS_KEY: "test-secret-key",
          AWS_REGION: "us-east-1",
        },
      );
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.created).toBe(true);
      expect(data.provider.type).toBe("aws-bedrock");
      expect(data.provider.authMethod).toBe("access-keys");
      expect(data.provider.secretNames).toContain("AWS_ACCESS_KEY_ID");
      expect(data.provider.secretNames).toContain("AWS_SECRET_ACCESS_KEY");
      expect(data.provider.secretNames).toContain("AWS_REGION");
    });

    it("should reject single-secret provider type in multi-auth", async () => {
      const response = await createMultiAuthProvider(
        "anthropic-api-key" as ModelProviderType,
        "api-key",
        { ANTHROPIC_API_KEY: "test" },
      );

      expect(response.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/zero/model-providers/[type]
  // ---------------------------------------------------------------------------

  describe("DELETE /api/zero/model-providers/[type]", () => {
    it("should delete an org provider", async () => {
      await createProvider("anthropic-api-key", "test-key");

      const request = createTestRequest(deleteUrl("anthropic-api-key"), {
        method: "DELETE",
      });
      const response = await DELETE(request);

      expect(response.status).toBe(204);

      const providers = await listProviders();
      expect(providers).toEqual([]);
    });

    it("should return 404 when deleting non-existent org provider", async () => {
      const request = createTestRequest(deleteUrl("anthropic-api-key"), {
        method: "DELETE",
      });
      const response = await DELETE(request);

      expect(response.status).toBe(404);
    });

    it("should reassign org default on delete", async () => {
      await createProvider("anthropic-api-key", "key-1");
      await createProvider("claude-code-oauth-token", "token-1");

      const request = createTestRequest(deleteUrl("anthropic-api-key"), {
        method: "DELETE",
      });
      await DELETE(request);

      const providers = await listProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]?.type).toBe("claude-code-oauth-token");
      expect(providers[0]?.isDefault).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/zero/model-providers/[type]/default  (set default)
  // ---------------------------------------------------------------------------

  describe("POST /api/zero/model-providers/[type]/default", () => {
    it("should switch org default with setDefault", async () => {
      await createProvider("anthropic-api-key", "key-1");
      await createProvider("claude-code-oauth-token", "token-1");

      const request = createTestRequest(
        setDefaultUrl("claude-code-oauth-token"),
        { method: "POST" },
      );
      const response = await setDefaultPOST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isDefault).toBe(true);

      const providers = await listProviders();
      const anthropic = providers.find((p) => {
        return p.type === "anthropic-api-key";
      });
      const oauth = providers.find((p) => {
        return p.type === "claude-code-oauth-token";
      });
      expect(anthropic!.isDefault).toBe(false);
      expect(oauth!.isDefault).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // codex-beta gate on POST /api/zero/model-providers
  // ---------------------------------------------------------------------------

  describe("openai-api-key codex-beta gate", () => {
    beforeEach(() => {
      mockIsFeatureEnabled.mockImplementation(() => {
        return true;
      });
    });

    it("creates openai-api-key provider when codex-beta is enabled", async () => {
      mockIsFeatureEnabled.mockImplementation((key) => {
        return key === FeatureSwitchKey.CodexBeta;
      });

      const response = await createProvider(
        "openai-api-key",
        "sk-proj-test",
        "gpt-5.5",
      );
      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.provider.type).toBe("openai-api-key");
      expect(data.provider.framework).toBe("codex");
    });

    it("returns 404 when codex-beta is disabled", async () => {
      mockIsFeatureEnabled.mockImplementation((key) => {
        return key !== FeatureSwitchKey.CodexBeta;
      });

      const response = await createProvider(
        "openai-api-key",
        "sk-proj-test",
        "gpt-5.5",
      );
      expect(response.status).toBe(404);
    });

    it("does not gate other provider types when codex-beta is disabled", async () => {
      mockIsFeatureEnabled.mockImplementation((key) => {
        return key !== FeatureSwitchKey.CodexBeta;
      });

      const response = await createProvider("anthropic-api-key", "sk-ant-test");
      expect(response.status).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-framework default — workspace-scoped (issue #11743)
  //
  // The workspace has at most one `is_default = true` row per (orgId, userId),
  // regardless of framework. Adding a provider in a different framework must
  // not steal default from the existing one; setDefault and delete-fallback
  // both operate workspace-wide.
  // ---------------------------------------------------------------------------

  describe("cross-framework default (workspace-scoped)", () => {
    beforeEach(() => {
      mockIsFeatureEnabled.mockImplementation(() => {
        return true;
      });
    });

    it("does not steal default when adding a different-framework provider", async () => {
      await createProvider("anthropic-api-key", "ant-key");
      await createProvider("openai-api-key", "sk-proj-test", "gpt-5.5");

      const providers = await listProviders();
      const anthropic = providers.find((p) => {
        return p.type === "anthropic-api-key";
      });
      const openai = providers.find((p) => {
        return p.type === "openai-api-key";
      });

      expect(anthropic!.isDefault).toBe(true);
      expect(openai!.isDefault).toBe(false);
      expect(
        providers.filter((p) => {
          return p.isDefault;
        }),
      ).toHaveLength(1);
    });

    it("setDefault flips default across frameworks atomically", async () => {
      await createProvider("anthropic-api-key", "ant-key");
      await createProvider("openai-api-key", "sk-proj-test", "gpt-5.5");

      const request = createTestRequest(setDefaultUrl("openai-api-key"), {
        method: "POST",
      });
      const response = await setDefaultPOST(request);
      expect(response.status).toBe(200);

      const providers = await listProviders();
      const anthropic = providers.find((p) => {
        return p.type === "anthropic-api-key";
      });
      const openai = providers.find((p) => {
        return p.type === "openai-api-key";
      });
      expect(anthropic!.isDefault).toBe(false);
      expect(openai!.isDefault).toBe(true);
    });

    it("delete reassigns default to earliest cross-framework provider", async () => {
      await createProvider("anthropic-api-key", "ant-key");
      await createProvider("openai-api-key", "sk-proj-test", "gpt-5.5");

      const request = createTestRequest(deleteUrl("anthropic-api-key"), {
        method: "DELETE",
      });
      await DELETE(request);

      const providers = await listProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]?.type).toBe("openai-api-key");
      expect(providers[0]?.isDefault).toBe(true);
    });
  });
});
