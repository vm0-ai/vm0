import { describe, expect, expectTypeOf, it } from "vitest";
import {
  MODEL_PROVIDER_REFRESH_PROVIDER_KEYS,
  getModelProviderRefreshMetadata,
  isModelProviderRefreshProviderKey,
  refreshModelProviderAccess,
} from "../auth-providers/model-provider-auth";

describe("model-provider refresh provider registry", () => {
  it("recognizes every registered model-provider refresh provider key", () => {
    for (const providerKey of MODEL_PROVIDER_REFRESH_PROVIDER_KEYS) {
      expect(isModelProviderRefreshProviderKey(providerKey)).toBe(true);
    }
  });

  it("returns refreshable metadata for every registered model-provider refresh provider key", () => {
    for (const providerKey of MODEL_PROVIDER_REFRESH_PROVIDER_KEYS) {
      expect(getModelProviderRefreshMetadata(providerKey)).toMatchObject({
        isRefreshable: true,
      });
    }
  });

  it("does not recognize connector or unknown provider keys", () => {
    expect(isModelProviderRefreshProviderKey("github")).toBe(false);
    expect(isModelProviderRefreshProviderKey("notion")).toBe(false);
    expect(isModelProviderRefreshProviderKey("totally-unknown")).toBe(false);
    expect(getModelProviderRefreshMetadata("totally-unknown")).toBe(undefined);
  });

  it("keeps registered provider refresh outputs typed by metadata", () => {
    const typedRefreshModelProviderAccess =
      refreshModelProviderAccess<"codex-oauth-token">;
    type CodexRefreshResult = Awaited<
      ReturnType<typeof typedRefreshModelProviderAccess>
    >;

    expectTypeOf<
      CodexRefreshResult["outputs"]["accessToken"]
    >().toEqualTypeOf<string>();
    expectTypeOf<CodexRefreshResult["outputs"]["refreshToken"]>().toEqualTypeOf<
      string | undefined
    >();
  });
});
