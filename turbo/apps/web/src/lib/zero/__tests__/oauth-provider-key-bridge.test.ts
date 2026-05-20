import { describe, it, expect } from "vitest";
import {
  MODEL_PROVIDER_OAUTH_PROVIDERS,
  getModelProviderOAuthProvider,
} from "@vm0/connectors/oauth-providers/model-provider-registry";
import { isOAuthRefreshProvider } from "@vm0/connectors/oauth-providers";
import {
  OAUTH_PROVIDER_KEY_SOURCE_TYPE,
  MODEL_PROVIDER_OAUTH_PROVIDER_KEY,
  OAUTH_PROVIDER_KEY_TO_MODEL_PROVIDER_TYPE,
  getOAuthProviderKeySourceType,
} from "../oauth-provider-key-bridge";

describe("provider-key bridge tables stay in sync", () => {
  it("every value in MODEL_PROVIDER_OAUTH_PROVIDER_KEY appears as a model-provider key in OAUTH_PROVIDER_KEY_SOURCE_TYPE", () => {
    for (const providerKey of Object.values(
      MODEL_PROVIDER_OAUTH_PROVIDER_KEY,
    )) {
      expect(providerKey).toBeDefined();
      expect(OAUTH_PROVIDER_KEY_SOURCE_TYPE[providerKey!]).toBe(
        "model-provider",
      );
    }
  });

  it("every key in OAUTH_PROVIDER_KEY_SOURCE_TYPE appears as a value in MODEL_PROVIDER_OAUTH_PROVIDER_KEY", () => {
    for (const providerKey of Object.keys(OAUTH_PROVIDER_KEY_SOURCE_TYPE)) {
      expect(Object.values(MODEL_PROVIDER_OAUTH_PROVIDER_KEY)).toContain(
        providerKey,
      );
    }
  });

  it("OAUTH_PROVIDER_KEY_TO_MODEL_PROVIDER_TYPE inverts MODEL_PROVIDER_OAUTH_PROVIDER_KEY", () => {
    for (const [providerType, providerKey] of Object.entries(
      MODEL_PROVIDER_OAUTH_PROVIDER_KEY,
    )) {
      expect(providerKey).toBeDefined();
      expect(OAUTH_PROVIDER_KEY_TO_MODEL_PROVIDER_TYPE[providerKey!]).toBe(
        providerType,
      );
    }
  });

  it("every provider key in OAUTH_PROVIDER_KEY_SOURCE_TYPE has a matching OAUTH_PROVIDER_KEY_TO_MODEL_PROVIDER_TYPE entry", () => {
    for (const providerKey of Object.keys(OAUTH_PROVIDER_KEY_SOURCE_TYPE)) {
      expect(
        OAUTH_PROVIDER_KEY_TO_MODEL_PROVIDER_TYPE[providerKey],
      ).toBeDefined();
    }
  });

  it("every bridged provider key resolves to a refresh-capable OAuth provider", () => {
    for (const providerKey of Object.values(
      MODEL_PROVIDER_OAUTH_PROVIDER_KEY,
    )) {
      const provider = getModelProviderOAuthProvider(providerKey!);
      expect(provider).toBeDefined();
      expect(provider && isOAuthRefreshProvider(provider)).toBe(true);
    }
  });

  it("every registered model-provider OAuth provider is bridged", () => {
    for (const providerKey of Object.keys(MODEL_PROVIDER_OAUTH_PROVIDERS)) {
      expect(OAUTH_PROVIDER_KEY_SOURCE_TYPE[providerKey]).toBe(
        "model-provider",
      );
      expect(
        OAUTH_PROVIDER_KEY_TO_MODEL_PROVIDER_TYPE[providerKey],
      ).toBeDefined();
    }
  });
});

describe("getOAuthProviderKeySourceType", () => {
  it("returns 'model-provider' for bridged provider keys", () => {
    expect(getOAuthProviderKeySourceType("codex-oauth-token")).toBe(
      "model-provider",
    );
  });

  it("returns 'connector' for unbridged provider keys (default)", () => {
    expect(getOAuthProviderKeySourceType("github")).toBe("connector");
    expect(getOAuthProviderKeySourceType("notion")).toBe("connector");
    expect(getOAuthProviderKeySourceType("totally-unknown")).toBe("connector");
  });
});
