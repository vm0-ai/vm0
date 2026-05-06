import { describe, it, expect } from "vitest";
import {
  getProviderBaseUrl,
  areProvidersCompatible,
  hasModelSelection,
  getModels,
  getDefaultModel,
  getEnvironmentMapping,
  getFrameworkForType,
  getVm0VisibleModels,
  normalizeVm0ModelId,
  getModelImageInputSupport,
  modelSupportsImageInput,
  getSelectableProviderTypes,
  getAuthMethodsForType,
  getSecretsForAuthMethod,
  VM0_MODEL_TO_PROVIDER,
  MODEL_PROVIDER_FIREWALL_CONFIGS,
  modelProviderTypeSchema,
  modelProviderFrameworkSchema,
  type ModelProviderType,
} from "../model-providers";

describe("getProviderBaseUrl", () => {
  it.each([
    "claude-code-oauth-token",
    "anthropic-api-key",
    "azure-foundry",
    "aws-bedrock",
    "openai-api-key",
  ] as ModelProviderType[])("returns null for %s", (type) => {
    expect(getProviderBaseUrl(type)).toBeNull();
  });

  it.each([
    ["openrouter-api-key", "https://openrouter.ai/api"],
    ["moonshot-api-key", "https://api.moonshot.ai/anthropic"],
    ["minimax-api-key", "https://api.minimax.io/anthropic"],
    ["deepseek-api-key", "https://api.deepseek.com/anthropic"],
    ["zai-api-key", "https://api.z.ai/api/anthropic"],
    ["vercel-ai-gateway", "https://ai-gateway.vercel.sh"],
  ] as [ModelProviderType, string][])(
    "returns correct URL for %s",
    (type, expectedUrl) => {
      expect(getProviderBaseUrl(type)).toBe(expectedUrl);
    },
  );
});

describe("areProvidersCompatible", () => {
  const anthropicNative: ModelProviderType[] = [
    "claude-code-oauth-token",
    "anthropic-api-key",
    "azure-foundry",
    "aws-bedrock",
  ];

  const thirdParty: ModelProviderType[] = [
    "openrouter-api-key",
    "moonshot-api-key",
    "minimax-api-key",
    "deepseek-api-key",
    "zai-api-key",
    "vercel-ai-gateway",
  ];

  it("all Anthropic-native providers are mutually compatible", () => {
    for (const a of anthropicNative) {
      for (const b of anthropicNative) {
        expect(areProvidersCompatible(a, b)).toBe(true);
      }
    }
  });

  it("every provider is compatible with itself", () => {
    for (const p of [...anthropicNative, ...thirdParty]) {
      expect(areProvidersCompatible(p, p)).toBe(true);
    }
  });

  it("Anthropic-native is incompatible with third-party providers", () => {
    for (const native of anthropicNative) {
      for (const tp of thirdParty) {
        expect(areProvidersCompatible(native, tp)).toBe(false);
        expect(areProvidersCompatible(tp, native)).toBe(false);
      }
    }
  });

  it("different third-party providers are incompatible", () => {
    expect(areProvidersCompatible("moonshot-api-key", "deepseek-api-key")).toBe(
      false,
    );
    expect(
      areProvidersCompatible("openrouter-api-key", "vercel-ai-gateway"),
    ).toBe(false);
    expect(areProvidersCompatible("minimax-api-key", "zai-api-key")).toBe(
      false,
    );
  });
});

describe("model selection for Anthropic-native providers", () => {
  it.each(["claude-code-oauth-token", "anthropic-api-key"] as const)(
    "%s supports model selection",
    (type) => {
      expect(hasModelSelection(type)).toBe(true);
    },
  );

  it.each(["claude-code-oauth-token", "anthropic-api-key"] as const)(
    "%s offers sonnet and opus models",
    (type) => {
      const models = getModels(type);
      expect(models).toContain("claude-sonnet-4-6");
      expect(models).toContain("claude-opus-4-6");
      expect(models).toContain("claude-opus-4-7");
    },
  );

  it.each(["claude-code-oauth-token", "anthropic-api-key"] as const)(
    "%s defaults to claude-sonnet-4-6",
    (type) => {
      expect(getDefaultModel(type)).toBe("claude-sonnet-4-6");
    },
  );

  it("anthropic-api-key maps ANTHROPIC_MODEL via environment mapping", () => {
    const mapping = getEnvironmentMapping("anthropic-api-key");
    expect(mapping).toBeDefined();
    expect(mapping!["ANTHROPIC_API_KEY"]).toBe("$secret");
    expect(mapping!["ANTHROPIC_MODEL"]).toBe("$model");
  });

  it("claude-code-oauth-token maps ANTHROPIC_MODEL via environment mapping", () => {
    const mapping = getEnvironmentMapping("claude-code-oauth-token");
    expect(mapping).toBeDefined();
    expect(mapping!["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("$secret");
    expect(mapping!["ANTHROPIC_MODEL"]).toBe("$model");
  });

  it("Anthropic-native providers have no ANTHROPIC_BASE_URL (use default)", () => {
    expect(getProviderBaseUrl("anthropic-api-key")).toBeNull();
    expect(getProviderBaseUrl("claude-code-oauth-token")).toBeNull();
  });
});

describe("getVm0VisibleModels", () => {
  it("returns all models when no features are provided", () => {
    const models = getVm0VisibleModels();
    expect(models).toContain("kimi-k2.5");
    expect(models).toContain("MiniMax-M2.7");
    expect(models).toContain("glm-5.1");
    expect(models).toContain("deepseek-v4-pro");
    expect(models).toContain("deepseek-v4-flash");
    // All feature-flagged models must be hidden when no features are provided
    const featureFlaggedModels = Object.entries(VM0_MODEL_TO_PROVIDER)
      .filter(([, config]) => {
        return config.featureFlag !== undefined;
      })
      .map(([model]) => {
        return model;
      });
    for (const model of featureFlaggedModels) {
      expect(models).not.toContain(model);
    }
  });

  it("DeepSeek V4 models and compatibility aliases are not feature gated", () => {
    const models = getVm0VisibleModels({});
    expect(models).toContain("deepseek-v4-pro");
    expect(models).toContain("deepseek-v4-flash");
  });
});

describe("normalizeVm0ModelId", () => {
  it.each([
    ["anthropic/claude-sonnet-4.6", "claude-sonnet-4-6"],
    ["deepseek/deepseek-v4-pro", "deepseek-v4-pro"],
    ["z-ai/glm-5.1", "glm-5.1"],
    ["moonshotai/kimi-k2.6", "kimi-k2.6"],
    ["minimax/minimax-m2.7", "MiniMax-M2.7"],
  ])("normalizes %s to %s", (model, expected) => {
    expect(normalizeVm0ModelId(model)).toBe(expected);
  });

  it("keeps unknown model ids unchanged", () => {
    expect(normalizeVm0ModelId("custom/model")).toBe("custom/model");
  });
});

describe("model image input support", () => {
  it.each([
    "claude-sonnet-4-6",
    "claude-opus-4-7",
    "kimi-k2.6",
    "kimi-k2.5",
    "moonshotai/kimi-k2.5",
  ])("marks %s as image-input capable", (model) => {
    expect(modelSupportsImageInput(model)).toBe(true);
    expect(getModelImageInputSupport(model)).toBe("supported");
  });

  it.each([
    "glm-5.1",
    "deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "MiniMax-M2.7",
  ])("marks %s as not image-input capable", (model) => {
    expect(modelSupportsImageInput(model)).toBe(false);
    expect(getModelImageInputSupport(model)).toBe("unsupported");
  });

  it("treats unknown model ids as unknown rather than unsupported", () => {
    expect(modelSupportsImageInput("custom/model")).toBe(false);
    expect(getModelImageInputSupport("custom/model")).toBe("unknown");
  });
});

describe("openai-api-key codex provider", () => {
  it("declares codex framework", () => {
    expect(getFrameworkForType("openai-api-key")).toBe("codex");
  });

  it("maps OPENAI_API_KEY and OPENAI_MODEL via environment mapping", () => {
    const mapping = getEnvironmentMapping("openai-api-key");
    expect(mapping).toBeDefined();
    expect(mapping!["OPENAI_API_KEY"]).toBe("$secret");
    expect(mapping!["OPENAI_MODEL"]).toBe("$model");
  });

  it("offers codex-compatible models with gpt-5.5 default", () => {
    const models = getModels("openai-api-key");
    expect(models).toContain("gpt-5.5");
    expect(models).toContain("gpt-5.4");
    expect(models).toContain("gpt-5.4-mini");
    expect(models).toContain("gpt-5.3-codex");
    expect(models).toContain("gpt-5.2");
    expect(getDefaultModel("openai-api-key")).toBe("gpt-5.5");
  });

  it("supports model selection", () => {
    expect(hasModelSelection("openai-api-key")).toBe(true);
  });

  it("firewall scopes to OpenAI Responses API", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["openai-api-key"];
    expect(config.apis).toHaveLength(1);
    expect(config.apis[0]!.base).toBe("https://api.openai.com/v1/responses");
    expect(config.apis[0]!.auth.headers).toEqual({
      Authorization: "Bearer ${{ secrets.OPENAI_API_KEY }}",
    });
  });

  it("modelProviderTypeSchema accepts openai-api-key", () => {
    expect(modelProviderTypeSchema.safeParse("openai-api-key").success).toBe(
      true,
    );
  });

  it("modelProviderFrameworkSchema accepts codex", () => {
    expect(modelProviderFrameworkSchema.safeParse("codex").success).toBe(true);
  });
});

describe("firewall base URL scoped to /v1/messages (#9560)", () => {
  it.each([
    ["anthropic-api-key", "https://api.anthropic.com/v1/messages"],
    ["claude-code-oauth-token", "https://api.anthropic.com/v1/messages"],
    ["openrouter-api-key", "https://openrouter.ai/api/v1/messages"],
    ["moonshot-api-key", "https://api.moonshot.ai/anthropic/v1/messages"],
    ["minimax-api-key", "https://api.minimax.io/anthropic/v1/messages"],
    ["deepseek-api-key", "https://api.deepseek.com/anthropic/v1/messages"],
    ["zai-api-key", "https://api.z.ai/api/anthropic/v1/messages"],
    ["vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1/messages"],
  ] as const)(
    "%s scopes firewall to /v1/messages path prefix",
    (type, expectedBase) => {
      const config = MODEL_PROVIDER_FIREWALL_CONFIGS[type];
      expect(config.apis).toHaveLength(1);
      expect(config.apis[0]!.base).toBe(expectedBase);
    },
  );
});

describe("chatgpt-oauth-token codex provider", () => {
  it("declares codex framework", () => {
    expect(getFrameworkForType("chatgpt-oauth-token")).toBe("codex");
  });

  it("appears in selectable provider types", () => {
    expect(getSelectableProviderTypes()).toContain("chatgpt-oauth-token");
  });

  it("uses multi-auth shape with oauth method and four secrets", () => {
    const methods = getAuthMethodsForType("chatgpt-oauth-token");
    expect(methods).toBeDefined();
    expect(Object.keys(methods!)).toEqual(["oauth"]);
    const secrets = methods!.oauth!.secrets;
    expect(Object.keys(secrets).sort()).toEqual([
      "CHATGPT_ACCESS_TOKEN",
      "CHATGPT_ACCOUNT_ID",
      "CHATGPT_ID_TOKEN",
      "CHATGPT_REFRESH_TOKEN",
    ]);
  });

  it("marks refresh and id tokens as serverOnly", () => {
    const secrets = getSecretsForAuthMethod("chatgpt-oauth-token", "oauth")!;
    expect(secrets.CHATGPT_REFRESH_TOKEN!.serverOnly).toBe(true);
    expect(secrets.CHATGPT_ID_TOKEN!.serverOnly).toBe(true);
    // Access token + account ID are NOT server-only — they reach the sandbox
    expect(secrets.CHATGPT_ACCESS_TOKEN!.serverOnly).not.toBe(true);
    expect(secrets.CHATGPT_ACCOUNT_ID!.serverOnly).not.toBe(true);
  });

  it("environmentMapping does NOT reference refresh or id tokens", () => {
    const mapping = getEnvironmentMapping("chatgpt-oauth-token")!;
    const values = Object.values(mapping).join(" ");
    expect(values).not.toContain("CHATGPT_REFRESH_TOKEN");
    expect(values).not.toContain("CHATGPT_ID_TOKEN");
  });

  it("environmentMapping injects access token, account id, and model", () => {
    const mapping = getEnvironmentMapping("chatgpt-oauth-token")!;
    expect(mapping.CHATGPT_ACCESS_TOKEN).toBe("$secrets.CHATGPT_ACCESS_TOKEN");
    expect(mapping.CHATGPT_ACCOUNT_ID).toBe("$secrets.CHATGPT_ACCOUNT_ID");
    expect(mapping.OPENAI_MODEL).toBe("$model");
  });

  it("offers gpt-5.x models with gpt-5.5 default", () => {
    expect(getModels("chatgpt-oauth-token")).toContain("gpt-5.5");
    expect(getModels("chatgpt-oauth-token")).toContain("gpt-5.3-codex");
    expect(getDefaultModel("chatgpt-oauth-token")).toBe("gpt-5.5");
  });

  it("supports model selection", () => {
    expect(hasModelSelection("chatgpt-oauth-token")).toBe(true);
  });

  it("getProviderBaseUrl returns null (codex provider, no ANTHROPIC_BASE_URL)", () => {
    expect(getProviderBaseUrl("chatgpt-oauth-token")).toBeNull();
  });

  it("firewall entry has both ChatGPT and auth.openai.com APIs", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["chatgpt-oauth-token"];
    expect(config.apis).toHaveLength(2);
    expect(config.apis[0]!.base).toBe("https://chatgpt.com/backend-api/codex");
    expect(config.apis[1]!.base).toBe("https://auth.openai.com");
  });

  it("firewall injects Authorization and ChatGPT-Account-ID headers", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["chatgpt-oauth-token"];
    expect(config.apis[0]!.auth.headers).toEqual({
      Authorization: "Bearer ${{ secrets.CHATGPT_ACCESS_TOKEN }}",
      "ChatGPT-Account-ID": "${{ secrets.CHATGPT_ACCOUNT_ID }}",
    });
  });

  it("firewall denies auth.openai.com via defaultPolicies + permission rule", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["chatgpt-oauth-token"];
    expect(config.defaultPolicies?.deny).toContain("denied");
    expect(config.defaultPolicies?.unknownPolicy).toBe("deny");
    expect(config.apis[1]!.permissions).toEqual([
      { name: "denied", rules: ["ANY /*"] },
    ]);
  });

  it("CHATGPT_ACCESS_TOKEN placeholder is an opaque marker (not a JWT)", () => {
    // Codex doesn't read this env var in ChatGPT mode — it reads the real
    // JWT from ~/.codex/auth.json (written by guest-agent #11877). The
    // firewall only needs a stable, non-empty marker to match-and-substitute
    // at egress. A JWT-shaped placeholder triggers Semgrep's
    // detected-jwt-token rule even though the contents are obvious dummies.
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["chatgpt-oauth-token"];
    const token = config.placeholders!.CHATGPT_ACCESS_TOKEN!;
    expect(token.length).toBeGreaterThan(20);
    // Not a 3-segment JWT — a single dotless string is fine.
    expect(token.split(".")).toHaveLength(1);
  });

  it("CHATGPT_ACCOUNT_ID placeholder equals #11877's literal", () => {
    // Cross-cut alignment with guest-agent (#11877): the account_id literal
    // is the single string that crosses both surfaces (firewall placeholder
    // map AND the auth.json the guest-agent fabricates). Keeping them in
    // lockstep means future readers can grep one literal and find both.
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["chatgpt-oauth-token"];
    expect(config.placeholders!.CHATGPT_ACCOUNT_ID).toBe(
      "ws_VM0_PLACEHOLDER_DO_NOT_TRUST",
    );
  });

  it("modelProviderTypeSchema accepts chatgpt-oauth-token", () => {
    expect(
      modelProviderTypeSchema.safeParse("chatgpt-oauth-token").success,
    ).toBe(true);
  });
});

describe("getFirewallBaseUrl regression — existing providers unchanged", () => {
  // Snapshot of every firewall-supported provider's base URL after the
  // per-provider refactor in #11878. Catches accidental URL changes for
  // existing providers when a new codex-framework provider is added.
  it.each([
    ["anthropic-api-key", "https://api.anthropic.com/v1/messages"],
    ["claude-code-oauth-token", "https://api.anthropic.com/v1/messages"],
    ["openrouter-api-key", "https://openrouter.ai/api/v1/messages"],
    ["moonshot-api-key", "https://api.moonshot.ai/anthropic/v1/messages"],
    ["minimax-api-key", "https://api.minimax.io/anthropic/v1/messages"],
    ["deepseek-api-key", "https://api.deepseek.com/anthropic/v1/messages"],
    ["zai-api-key", "https://api.z.ai/api/anthropic/v1/messages"],
    ["vercel-ai-gateway", "https://ai-gateway.vercel.sh/v1/messages"],
    ["openai-api-key", "https://api.openai.com/v1/responses"],
    ["chatgpt-oauth-token", "https://chatgpt.com/backend-api/codex"],
  ] as const)("%s firewall base URL is %s", (type, expected) => {
    expect(MODEL_PROVIDER_FIREWALL_CONFIGS[type]!.apis[0]!.base).toBe(expected);
  });
});
