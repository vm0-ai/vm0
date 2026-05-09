import { describe, expect, it } from "vitest";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { composerModelProviders$ } from "../composer-model-providers.ts";
import { setMockOrgModelProviders } from "../../../mocks/handlers/api-org-model-providers.ts";
import { setMockPersonalModelProviders } from "../../../mocks/handlers/api-personal-model-providers.ts";

const context = testContext();

const ORG_A = "11111111-1111-4111-8111-111111111111";
const PERSONAL_X = "33333333-3333-4333-8333-333333333333";

function makeProvider(
  id: string,
  type: ModelProviderResponse["type"],
  isDefault = false,
): ModelProviderResponse {
  return {
    id,
    type,
    framework: "claude-code",
    secretName: null,
    authMethod: null,
    secretNames: null,
    isDefault,
    selectedModel: null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("composerModelProviders$", () => {
  it("returns org providers and ignores personal provider rows", async () => {
    setMockOrgModelProviders([makeProvider(ORG_A, "anthropic-api-key", true)]);
    setMockPersonalModelProviders([
      makeProvider(PERSONAL_X, "openai-api-key", true),
    ]);

    detachedSetupPage({ context, path: "/", withoutRender: true });

    const result = await context.store.get(composerModelProviders$);

    expect(
      result.providers.map((provider) => {
        return provider.id;
      }),
    ).toStrictEqual([ORG_A]);
  });
});
