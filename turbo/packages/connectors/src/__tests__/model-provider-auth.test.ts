import { describe, expect, it } from "vitest";
import {
  MODEL_PROVIDER_OAUTH_PROVIDER_KEYS,
  getModelProviderOAuthSecretMetadata,
  isModelProviderOAuthProviderKey,
} from "../auth-providers/model-provider-auth";

describe("model-provider OAuth provider registry", () => {
  it("recognizes every registered model-provider OAuth provider key", () => {
    for (const providerKey of MODEL_PROVIDER_OAUTH_PROVIDER_KEYS) {
      expect(isModelProviderOAuthProviderKey(providerKey)).toBe(true);
    }
  });

  it("returns refreshable metadata for every registered model-provider OAuth provider key", () => {
    for (const providerKey of MODEL_PROVIDER_OAUTH_PROVIDER_KEYS) {
      expect(getModelProviderOAuthSecretMetadata(providerKey)).toMatchObject({
        isRefreshable: true,
      });
    }
  });

  it("does not recognize connector or unknown provider keys", () => {
    expect(isModelProviderOAuthProviderKey("github")).toBe(false);
    expect(isModelProviderOAuthProviderKey("notion")).toBe(false);
    expect(isModelProviderOAuthProviderKey("totally-unknown")).toBe(false);
    expect(getModelProviderOAuthSecretMetadata("totally-unknown")).toBe(
      undefined,
    );
  });
});
