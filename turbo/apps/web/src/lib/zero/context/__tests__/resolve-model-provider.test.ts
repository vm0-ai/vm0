import { describe, it, expect, beforeEach } from "vitest";
import { resolveModelProviderSecrets } from "../resolve-model-provider";
import { isNoModelProvider } from "@vm0/api-services/errors";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import {
  createTestOrg,
  insertOrgDefaultModelProvider,
} from "../../../../__tests__/api-test-helpers";
import { getTestModelProviderIdByType } from "../../../../__tests__/db-test-assertions/org";
import { mockClerk } from "../../../../__tests__/clerk-mock";

const context = testContext();

async function setupOrg(userId: string): Promise<string> {
  const orgSlug = uniqueId("resolver");
  const orgId = `org_mock_${userId}`;
  mockClerk({
    userId,
    orgId,
    orgRole: "org:admin",
    orgSlug,
    clerkOrgs: [{ id: orgId, slug: orgSlug, name: orgSlug, role: "org:admin" }],
  });
  await createTestOrg(orgSlug);
  return orgId;
}

describe("resolveModelProviderSecrets — framework gate removed (#11526)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("short-circuits on hasExplicitModelProviderConfig regardless of framework", async () => {
    const userId = uniqueId("explicit-codex");
    const orgId = await setupOrg(userId);

    const result = await resolveModelProviderSecrets(orgId, "codex", true);

    expect(result.secrets).toBeUndefined();
    expect(result.injectedEnvironment).toBeUndefined();
    expect(result.resolvedModelProvider).toBeUndefined();
    expect(result.framework).toBe("codex");
  });

  it("short-circuits on hasExplicitModelProviderConfig for claude-code too", async () => {
    const userId = uniqueId("explicit-cc");
    const orgId = await setupOrg(userId);

    const result = await resolveModelProviderSecrets(
      orgId,
      "claude-code",
      true,
    );

    expect(result.framework).toBe("claude-code");
    expect(result.resolvedModelProvider).toBeUndefined();
  });

  it("falls through to provider resolution for non-claude-code framework when no explicit config", async () => {
    // Pre-#11526 behavior: returned silently with framework gate. Post-#11526:
    // resolver runs to provider lookup, finds no codex provider, throws.
    const userId = uniqueId("codex-noprov");
    const orgId = await setupOrg(userId);

    await expect(
      resolveModelProviderSecrets(orgId, "codex", false),
    ).rejects.toSatisfy((err: unknown) => {
      return isNoModelProvider(err);
    });
  });

  it("populates framework from the resolved provider for claude-code", async () => {
    const userId = uniqueId("cc-anthropic");
    const orgId = await setupOrg(userId);
    await insertOrgDefaultModelProvider(orgId, "anthropic-api-key");

    // Secret value is absent — resolver returns the metadata without secrets.
    const result = await resolveModelProviderSecrets(
      orgId,
      "claude-code",
      false,
    );

    expect(result.resolvedModelProvider).toBe("anthropic-api-key");
    expect(result.framework).toBe("claude-code");
  });

  it("provider's framework wins when modelProviderId pin disagrees with compose framework (#11616)", async () => {
    // Production-shaped path: compose declares (or defaults to) framework:
    // claude-code, but the thread is eager-pinned (#11528) to a modelProviderId
    // for an openai-api-key provider whose declared framework is codex. Per
    // Epic #11520 the provider's framework must win — no throw.
    const userId = uniqueId("eager-pin-codex");
    const orgId = await setupOrg(userId);
    await insertOrgDefaultModelProvider(orgId, "openai-api-key");
    const modelProviderId = await getTestModelProviderIdByType(
      orgId,
      "openai-api-key",
    );

    const result = await resolveModelProviderSecrets(
      orgId,
      "claude-code",
      false,
      undefined,
      modelProviderId,
    );

    expect(result.resolvedModelProvider).toBe("openai-api-key");
    expect(result.framework).toBe("codex");
  });
});
