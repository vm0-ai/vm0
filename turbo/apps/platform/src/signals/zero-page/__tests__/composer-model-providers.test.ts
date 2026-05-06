import { describe, expect, it } from "vitest";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { composerModelProviders$ } from "../composer-model-providers.ts";
import { setMockOrgModelProviders } from "../../../mocks/handlers/api-org-model-providers.ts";
import { setMockPersonalModelProviders } from "../../../mocks/handlers/api-personal-model-providers.ts";

const context = testContext();

// UUIDs match the response schema's strict format. The string body is
// only used for human-readable assertions in failure output.
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const PERSONAL_X = "33333333-3333-4333-8333-333333333333";
const PERSONAL_Y = "44444444-4444-4444-8444-444444444444";

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

describe("composerModelProviders$ — Wave 3 of Epic #11868", () => {
  it("returns org-only with undefined tiers when feature switch is off", async () => {
    setMockOrgModelProviders([makeProvider(ORG_A, "anthropic-api-key", true)]);
    // Personal seeded but switch is off — must be ignored.
    setMockPersonalModelProviders([
      makeProvider(PERSONAL_X, "openai-api-key", true),
    ]);

    detachedSetupPage({ context, path: "/", withoutRender: true });

    const result = await context.store.get(composerModelProviders$);

    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]?.id).toBe(ORG_A);
    // Undefined tiers signals the picker to render its legacy flat list
    // — byte-for-byte unchanged when the switch is off.
    expect(result.tiers).toBeUndefined();
  });

  it("returns org-only when switch is off even with seeded personal rows (gate verified)", async () => {
    // Inversion of the previous case — emphasises that the gate is the
    // switch, not the personal-list emptiness. If the gate ever regresses
    // to "merge whenever the personal endpoint returns data", this catches it.
    setMockOrgModelProviders([makeProvider(ORG_A, "anthropic-api-key")]);
    setMockPersonalModelProviders([makeProvider(PERSONAL_X, "openai-api-key")]);

    detachedSetupPage({ context, path: "/", withoutRender: true });

    const result = await context.store.get(composerModelProviders$);

    expect(
      result.providers.map((p) => {
        return p.id;
      }),
    ).toStrictEqual([ORG_A]);
    expect(result.tiers).toBeUndefined();
  });

  it("returns org-only when switch is on but user has no personal providers", async () => {
    setMockOrgModelProviders([
      makeProvider(ORG_A, "anthropic-api-key", true),
      makeProvider(ORG_B, "openai-api-key"),
    ]);
    setMockPersonalModelProviders([]);

    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.PersonalModelProvider]: true },
      withoutRender: true,
    });

    const result = await context.store.get(composerModelProviders$);

    expect(
      result.providers.map((p) => {
        return p.id;
      }),
    ).toStrictEqual([ORG_A, ORG_B]);
    expect(result.tiers).toBeDefined();
    expect(result.tiers?.get(ORG_A)).toBe("org");
    expect(result.tiers?.get(ORG_B)).toBe("org");
  });

  it("merges personal-first when switch is on and both tiers populated", async () => {
    setMockOrgModelProviders([
      makeProvider(ORG_A, "anthropic-api-key", true),
      makeProvider(ORG_B, "openai-api-key"),
    ]);
    setMockPersonalModelProviders([
      makeProvider(PERSONAL_X, "anthropic-api-key", true),
      makeProvider(PERSONAL_Y, "openai-api-key"),
    ]);

    detachedSetupPage({
      context,
      path: "/",
      featureSwitches: { [FeatureSwitchKey.PersonalModelProvider]: true },
      withoutRender: true,
    });

    const result = await context.store.get(composerModelProviders$);

    expect(
      result.providers.map((p) => {
        return p.id;
      }),
    ).toStrictEqual([PERSONAL_X, PERSONAL_Y, ORG_A, ORG_B]);
    expect(result.tiers).toBeDefined();
    expect(result.tiers?.get(PERSONAL_X)).toBe("personal");
    expect(result.tiers?.get(PERSONAL_Y)).toBe("personal");
    expect(result.tiers?.get(ORG_A)).toBe("org");
    expect(result.tiers?.get(ORG_B)).toBe("org");
  });
});
