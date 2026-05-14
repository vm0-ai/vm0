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
  getCanonicalModelDisplayName,
  getDefaultOrgModelPolicySeed,
  getProviderRuntimeModel,
  getProvidersForModel,
  isModelSupportedByProvider,
  isSupportedRunModel,
  normalizeRunModelId,
  getAuthMethodsForType,
  getSecretsForAuthMethod,
  modelProviderCredentialScopeSchema,
  supportedRunModelSchema,
  DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  SUPPORTED_RUN_MODELS,
  DEFAULT_ORG_MODEL_POLICY_MODELS,
  MODEL_PROVIDER_FIREWALL_CONFIGS,
  MODEL_PROVIDER_TYPES,
  modelProviderTypeSchema,
  modelProviderFrameworkSchema,
  type ModelProviderType,
} from "../model-providers";
import { findMatchingPermissions } from "@vm0/connectors/firewall-rule-matcher";

describe("model-first canonical catalog", () => {
  it("exposes the curated flat model list only", () => {
    expect(SUPPORTED_RUN_MODELS).toEqual([
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "kimi-k2.6",
      "kimi-k2.5",
      "MiniMax-M2.7",
      "glm-5.1",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
  });

  it("validates canonical models and credential scopes", () => {
    expect(supportedRunModelSchema.safeParse("gpt-5.5").success).toBe(true);
    expect(supportedRunModelSchema.safeParse("custom-model").success).toBe(
      false,
    );
    expect(modelProviderCredentialScopeSchema.safeParse("org").success).toBe(
      true,
    );
    expect(modelProviderCredentialScopeSchema.safeParse("member").success).toBe(
      true,
    );
    expect(
      modelProviderCredentialScopeSchema.safeParse("personal").success,
    ).toBe(false);
  });

  it("surfaces display labels for canonical models", () => {
    expect(getCanonicalModelDisplayName("claude-opus-4-7")).toBe(
      "Claude Opus 4.7",
    );
    expect(getCanonicalModelDisplayName("custom/model")).toBe("custom/model");
  });

  it("normalizes provider aliases without accepting unsupported models", () => {
    expect(normalizeRunModelId("z-ai/glm-5.1")).toBe("glm-5.1");
    expect(normalizeRunModelId("custom/model")).toBe("custom/model");
    expect(isSupportedRunModel("glm-5.1")).toBe(true);
    expect(isSupportedRunModel("deepseek-v4-flash")).toBe(true);
  });

  it("returns compatible provider types for canonical models", () => {
    expect(getProvidersForModel("claude-opus-4-7")).toEqual([
      "vm0",
      "claude-code-oauth-token",
      "anthropic-api-key",
      "openrouter-api-key",
      "vercel-ai-gateway",
    ]);
    expect(getProvidersForModel("gpt-5.5")).toEqual([
      "vm0",
      "openai-api-key",
      "codex-oauth-token",
      "openrouter-codex",
      "vercel-ai-gateway-codex",
    ]);
    expect(getProvidersForModel("deepseek/deepseek-v4-pro")).toContain(
      "openrouter-api-key",
    );
    expect(getProvidersForModel("minimax/minimax-m2.7")).toEqual([
      "vm0",
      "minimax-api-key",
      "openrouter-api-key",
    ]);
    expect(getProvidersForModel("custom/model")).toEqual([]);
  });

  it("checks model/provider compatibility", () => {
    expect(isModelSupportedByProvider("gpt-5.5", "openai-api-key")).toBe(true);
    expect(isModelSupportedByProvider("gpt-5.5", "anthropic-api-key")).toBe(
      false,
    );
    expect(isModelSupportedByProvider("anthropic/claude-opus-4.7", "vm0")).toBe(
      true,
    );
  });

  it("maps canonical models to provider runtime model ids", () => {
    expect(getProviderRuntimeModel("openrouter-api-key", "glm-5.1")).toBe(
      "z-ai/glm-5.1",
    );
    expect(getProviderRuntimeModel("openrouter-api-key", "kimi-k2.6")).toBe(
      "moonshotai/kimi-k2.6",
    );
    expect(getProviderRuntimeModel("openrouter-api-key", "MiniMax-M2.7")).toBe(
      "minimax/minimax-m2.7",
    );
    expect(
      getProviderRuntimeModel("anthropic-api-key", "claude-opus-4-7"),
    ).toBe("claude-opus-4-7");
    expect(getProviderRuntimeModel("vm0", "glm-5.1")).toBe("z-ai/glm-5.1");
    expect(getProviderRuntimeModel("openai-api-key", "gpt-5.5")).toBe(
      "gpt-5.5",
    );
    expect(getProviderRuntimeModel("openrouter-api-key", "custom/model")).toBe(
      "custom/model",
    );
  });

  it("builds the default org policy seed from the workspace defaults", () => {
    expect(DEFAULT_ORG_MODEL_POLICY_MODELS).toEqual([
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "deepseek-v4-pro",
      "gpt-5.5",
    ]);
    expect(getDefaultOrgModelPolicySeed()).toEqual(
      DEFAULT_ORG_MODEL_POLICY_MODELS.map((model) => {
        return {
          model,
          isDefault: model === DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
        };
      }),
    );
  });
});

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
    ["openrouter-codex", "https://openrouter.ai/api/v1"],
    ["vercel-ai-gateway-codex", "https://ai-gateway.vercel.sh/v1"],
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
  it("returns all VM0 managed models", () => {
    const models = getVm0VisibleModels();
    expect(models).toContain("kimi-k2.5");
    expect(models).toContain("MiniMax-M2.7");
    expect(models).toContain("glm-5.1");
    expect(models).toContain("deepseek-v4-pro");
    expect(models).toContain("deepseek-v4-flash");
    expect(models).toContain("gpt-5.5");
    expect(models).toContain("gpt-5.4-mini");
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
    expect(getModels("openai-api-key")).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
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

describe("codex-oauth-token codex provider", () => {
  it("declares codex framework", () => {
    expect(getFrameworkForType("codex-oauth-token")).toBe("codex");
  });

  it("appears in selectable provider types", () => {
    expect(getSelectableProviderTypes()).toContain("codex-oauth-token");
  });

  it("supports OAuth and auth_json multi-auth shapes with CHATGPT_* fields", () => {
    const methods = getAuthMethodsForType("codex-oauth-token");
    expect(methods).toBeDefined();
    expect(Object.keys(methods!)).toEqual(["oauth", "auth_json"]);
    const oauthSecrets = methods!.oauth!.secrets;
    expect(Object.keys(oauthSecrets).sort()).toEqual([
      "CHATGPT_ACCESS_TOKEN",
      "CHATGPT_ACCOUNT_ID",
      "CHATGPT_ID_TOKEN",
      "CHATGPT_REFRESH_TOKEN",
    ]);
    const authJsonSecrets = methods!.auth_json!.secrets;
    expect(Object.keys(authJsonSecrets).sort()).toEqual([
      "CHATGPT_ACCESS_TOKEN",
      "CHATGPT_ACCOUNT_ID",
      "CHATGPT_ID_TOKEN",
      "CHATGPT_REFRESH_TOKEN",
      "CODEX_AUTH_JSON",
    ]);
  });

  it("defaultAuthMethod is auth_json", () => {
    const config = MODEL_PROVIDER_TYPES["codex-oauth-token"];
    expect(
      "defaultAuthMethod" in config ? config.defaultAuthMethod : undefined,
    ).toBe("auth_json");
  });

  it("marks refresh and id tokens as serverOnly under auth_json", () => {
    const secrets = getSecretsForAuthMethod("codex-oauth-token", "auth_json")!;
    expect(secrets.CHATGPT_REFRESH_TOKEN!.serverOnly).toBe(true);
    expect(secrets.CHATGPT_ID_TOKEN!.serverOnly).toBe(true);
    // Access token + account ID are NOT server-only — they reach the sandbox
    // as placeholder values, substituted by the firewall token-replacement
    // layer at egress.
    expect(secrets.CHATGPT_ACCESS_TOKEN!.serverOnly).not.toBe(true);
    expect(secrets.CHATGPT_ACCOUNT_ID!.serverOnly).not.toBe(true);
  });

  it("CODEX_AUTH_JSON wire-shape secret is optional and serverOnly (raw blob never persisted nor reaches sandbox)", () => {
    const secrets = getSecretsForAuthMethod("codex-oauth-token", "auth_json")!;
    expect(secrets.CODEX_AUTH_JSON!.serverOnly).toBe(true);
    expect(secrets.CODEX_AUTH_JSON!.required).toBe(false);
  });

  it("environmentMapping does NOT reference refresh or id tokens", () => {
    const mapping = getEnvironmentMapping("codex-oauth-token")!;
    const values = Object.values(mapping).join(" ");
    expect(values).not.toContain("CHATGPT_REFRESH_TOKEN");
    expect(values).not.toContain("CHATGPT_ID_TOKEN");
  });

  it("environmentMapping injects access token, account id, and model", () => {
    const mapping = getEnvironmentMapping("codex-oauth-token")!;
    expect(mapping.CHATGPT_ACCESS_TOKEN).toBe("$secrets.CHATGPT_ACCESS_TOKEN");
    expect(mapping.CHATGPT_ACCOUNT_ID).toBe("$secrets.CHATGPT_ACCOUNT_ID");
    expect(mapping.OPENAI_MODEL).toBe("$model");
  });

  it("offers gpt-5.x models with gpt-5.5 default", () => {
    expect(getModels("codex-oauth-token")).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
    expect(getDefaultModel("codex-oauth-token")).toBe("gpt-5.5");
  });

  it("supports model selection", () => {
    expect(hasModelSelection("codex-oauth-token")).toBe(true);
  });

  it("getProviderBaseUrl returns null (codex provider, no ANTHROPIC_BASE_URL)", () => {
    expect(getProviderBaseUrl("codex-oauth-token")).toBeNull();
  });

  it("firewall entry has both ChatGPT and auth.openai.com APIs", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    expect(config.apis).toHaveLength(2);
    expect(config.apis[0]!.base).toBe("https://chatgpt.com/backend-api/codex");
    expect(config.apis[1]!.base).toBe("https://auth.openai.com");
  });

  it("firewall injects Authorization and ChatGPT-Account-ID headers", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    expect(config.apis[0]!.auth.headers).toEqual({
      Authorization: "Bearer ${{ secrets.CHATGPT_ACCESS_TOKEN }}",
      "ChatGPT-Account-ID": "${{ secrets.CHATGPT_ACCOUNT_ID }}",
    });
  });

  it("firewall allows the entire ChatGPT Codex backend subtree under GET/POST", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    expect(config.apis[0]!.permissions).toEqual([
      {
        name: "codex:api",
        rules: ["GET /{path*}", "POST /{path*}"],
      },
    ]);
  });

  it.each([
    ["GET", "/models"],
    ["GET", "/responses"],
    ["POST", "/responses"],
    ["POST", "/responses/compact"],
    ["GET", "/responses/abc123"],
    ["POST", "/analytics-events/events"],
  ] as const)("codex:api permission matches %s %s", (method, path) => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    const fwConfig = { name: config.name, apis: [config.apis[0]!] };
    expect(findMatchingPermissions(method, path, fwConfig)).toEqual([
      "codex:api",
    ]);
  });

  it.each([
    ["DELETE", "/responses/abc123"],
    ["PUT", "/responses/abc123"],
    ["PATCH", "/settings"],
  ] as const)(
    "codex:api permission rejects %s %s (method narrowing)",
    (method, path) => {
      const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
      const fwConfig = { name: config.name, apis: [config.apis[0]!] };
      expect(findMatchingPermissions(method, path, fwConfig)).toEqual([]);
    },
  );

  it("firewall denies auth.openai.com via defaultPolicies + permission rule", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    expect(config.defaultPolicies).toEqual({
      deny: ["denied"],
      unknownPolicy: "deny",
    });
    expect(config.apis[1]!.permissions).toEqual([
      { name: "denied", rules: ["ANY /*"] },
    ]);
  });

  it.each([
    ["GET", "/"],
    ["POST", "/oauth/token"],
    ["DELETE", "/sessions/abc"],
  ] as const)(
    "auth.openai.com matches no allow permission for %s %s",
    (method, path) => {
      // The `ANY /*` rule on apis[1] is a literal-segment match on "*" and
      // never matches real traffic — that's intentional. The deny is
      // delivered by defaultPolicies.unknownPolicy: "deny" (asserted just
      // above), so traffic to auth.openai.com must NOT resolve to any
      // permission name on apis[1]. This pins behavior so a future edit
      // to `apis[1].permissions` (e.g. adding an allow rule) breaks the
      // test rather than silently widening auth.openai.com.
      const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
      const fwConfig = { name: config.name, apis: [config.apis[1]!] };
      expect(findMatchingPermissions(method, path, fwConfig)).toEqual([]);
    },
  );

  it("CHATGPT_ACCESS_TOKEN placeholder is an opaque marker (not a JWT)", () => {
    // Codex doesn't read this env var in ChatGPT mode — it reads the real
    // JWT from ~/.codex/auth.json (written by guest-agent #11877). The
    // firewall only needs a stable, non-empty marker to match-and-substitute
    // at egress. A JWT-shaped placeholder triggers Semgrep's
    // detected-jwt-token rule even though the contents are obvious dummies.
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    const token = config.placeholders!.CHATGPT_ACCESS_TOKEN!;
    expect(token.length).toBeGreaterThan(20);
    // Not a 3-segment JWT — a single dotless string is fine.
    expect(token.split(".")).toHaveLength(1);
  });

  it("firewall placeholders expose the Codex OAuth fake marker bytes", () => {
    const config = MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"];
    expect(config.placeholders).toEqual({
      CHATGPT_ACCESS_TOKEN:
        "chatgpt-token-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocal",
      CHATGPT_ACCOUNT_ID: "ws_VM0_PLACEHOLDER_DO_NOT_TRUST",
      CHATGPT_REFRESH_TOKEN: "rt_VM0_PLACEHOLDER_DO_NOT_TRUST",
    });
  });

  it("modelProviderTypeSchema accepts codex-oauth-token", () => {
    expect(modelProviderTypeSchema.safeParse("codex-oauth-token").success).toBe(
      true,
    );
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
    ["codex-oauth-token", "https://chatgpt.com/backend-api/codex"],
    // Codex gateway providers scope the firewall to OPENAI_BASE_URL so codex
    // can use either /chat/completions or /responses paths the gateway
    // proxies — distinct from the narrow /v1/responses scope on the OpenAI
    // direct provider.
    ["openrouter-codex", "https://openrouter.ai/api/v1"],
    ["vercel-ai-gateway-codex", "https://ai-gateway.vercel.sh/v1"],
  ] as const)("%s firewall base URL is %s", (type, expected) => {
    expect(MODEL_PROVIDER_FIREWALL_CONFIGS[type]!.apis[0]!.base).toBe(expected);
  });
});

describe("codex-framework gateway providers (openrouter-codex, vercel-ai-gateway-codex)", () => {
  it.each(["openrouter-codex", "vercel-ai-gateway-codex"] as const)(
    "%s declares codex framework",
    (type) => {
      expect(getFrameworkForType(type)).toBe("codex");
    },
  );

  it.each(["openrouter-codex", "vercel-ai-gateway-codex"] as const)(
    "%s maps OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL",
    (type) => {
      const mapping = getEnvironmentMapping(type);
      expect(mapping).toBeDefined();
      expect(mapping!["OPENAI_API_KEY"]).toBe("$secret");
      expect(mapping!["OPENAI_BASE_URL"]).toMatch(/^https:\/\//);
      expect(mapping!["OPENAI_MODEL"]).toBe("$model");
    },
  );

  it.each(["openrouter-codex", "vercel-ai-gateway-codex"] as const)(
    "%s offers GPT models with gpt-5.5 default",
    (type) => {
      expect(getModels(type)).toEqual([
        "openai/gpt-5.5",
        "openai/gpt-5.4",
        "openai/gpt-5.4-mini",
      ]);
      expect(getDefaultModel(type)).toBe("openai/gpt-5.5");
    },
  );

  it("appear in selectable provider types", () => {
    const selectable = getSelectableProviderTypes();
    expect(selectable).toContain("openrouter-codex");
    expect(selectable).toContain("vercel-ai-gateway-codex");
  });

  it("translate canonical GPT models to vendor-prefixed runtime IDs", () => {
    expect(getProviderRuntimeModel("openrouter-codex", "gpt-5.5")).toBe(
      "openai/gpt-5.5",
    );
    expect(getProviderRuntimeModel("vercel-ai-gateway-codex", "gpt-5.4")).toBe(
      "openai/gpt-5.4",
    );
    expect(
      getProviderRuntimeModel("vercel-ai-gateway-codex", "gpt-5.4-mini"),
    ).toBe("openai/gpt-5.4-mini");
  });

  it("share the secretName with their claude-code twin gateway", () => {
    // Same API key powers both protocols on the same upstream gateway.
    // The codex twin must not invent a separate secret env var.
    const openrouterCodex = MODEL_PROVIDER_TYPES["openrouter-codex"];
    const openrouterClaudeCode = MODEL_PROVIDER_TYPES["openrouter-api-key"];
    expect(openrouterCodex.secretName).toBe(openrouterClaudeCode.secretName);

    const vercelCodex = MODEL_PROVIDER_TYPES["vercel-ai-gateway-codex"];
    const vercelClaudeCode = MODEL_PROVIDER_TYPES["vercel-ai-gateway"];
    expect(vercelCodex.secretName).toBe(vercelClaudeCode.secretName);
  });

  it("are NOT compatible with their claude-code twin (different protocol)", () => {
    expect(
      areProvidersCompatible("openrouter-codex", "openrouter-api-key"),
    ).toBe(false);
    expect(
      areProvidersCompatible("vercel-ai-gateway-codex", "vercel-ai-gateway"),
    ).toBe(false);
  });

  it("modelProviderTypeSchema accepts both new types", () => {
    expect(modelProviderTypeSchema.safeParse("openrouter-codex").success).toBe(
      true,
    );
    expect(
      modelProviderTypeSchema.safeParse("vercel-ai-gateway-codex").success,
    ).toBe(true);
  });

  it.each(["openrouter-codex", "vercel-ai-gateway-codex"] as const)(
    "%s firewall injects Authorization: Bearer header on the resolved base",
    (type) => {
      const config = MODEL_PROVIDER_FIREWALL_CONFIGS[type];
      expect(config.apis).toHaveLength(1);
      expect(config.apis[0]!.auth.headers).toMatchObject({
        Authorization: expect.stringMatching(
          /^Bearer \$\{\{ secrets\.[A-Z_]+ \}\}$/,
        ),
      });
    },
  );
});
