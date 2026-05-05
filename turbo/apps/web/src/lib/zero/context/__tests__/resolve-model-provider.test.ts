import { describe, it, expect, beforeEach } from "vitest";
import { resolveModelProviderSecrets } from "../resolve-model-provider";
import { isNoModelProvider } from "@vm0/api-services/errors";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import {
  createTestOrg,
  insertOrgDefaultModelProvider,
  insertOrgNonDefaultModelProvider,
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

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "codex",
      true,
    );

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
      userId,
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
      resolveModelProviderSecrets(orgId, userId, "codex", false),
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
      userId,
      "claude-code",
      false,
    );

    expect(result.resolvedModelProvider).toBe("anthropic-api-key");
    expect(result.framework).toBe("claude-code");
  });

  it("does not borrow workspace default's selectedModel when explicit modelProvider type differs (#11743)", async () => {
    // After #11743's single-default constraint, an org has at most one
    // is_default row across all provider types. When a request explicitly
    // passes `modelProvider` (e.g. POST /api/zero/chat/messages with
    // modelProvider="openai-api-key") and the workspace default is a
    // different type carrying its own selectedModel, the resolver MUST NOT
    // pass that selectedModel through — otherwise the codex CLI receives
    // OPENAI_MODEL=claude-sonnet-4-5 (a claude model) and refuses to run.
    // Regression observed in t-codex-zero-byok-smoke after the e2e helper
    // started overriding modelProvider in the request body.
    const userId = uniqueId("cross-type-default");
    const orgId = await setupOrg(userId);
    await insertOrgDefaultModelProvider(
      orgId,
      "claude-code-oauth-token",
      "claude-sonnet-4-5",
    );

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "codex",
      false,
      "openai-api-key",
    );

    expect(result.resolvedModelProvider).toBe("openai-api-key");
    expect(result.framework).toBe("codex");
    // The leak that #11743 surfaced: prior to the fix `selectedModel` would
    // be `claude-sonnet-4-5` (borrowed from the unrelated workspace default).
    // Post-fix it must be undefined so resolveEnvironmentMapping falls back
    // to getDefaultModel("openai-api-key") = "gpt-5.5".
    expect(result.selectedModel).toBeUndefined();
  });

  it("uses explicit provider's stored selectedModel when its type differs from workspace default (#11743)", async () => {
    // Companion to the leak test above: when the workspace default is one
    // type but the explicit override has its own non-default row in the same
    // org, the resolver MUST surface that row's selectedModel — otherwise
    // vm0 (which throws without selectedModel) and explicit BYOK overrides
    // lose their per-provider model pin. Regression observed in t54-1
    // (vm0 meta-provider — firewall billable) after the workspace-scoping
    // change.
    const userId = uniqueId("explicit-row-lookup");
    const orgId = await setupOrg(userId);
    await insertOrgDefaultModelProvider(
      orgId,
      "claude-code-oauth-token",
      "claude-sonnet-4-6",
    );
    await insertOrgNonDefaultModelProvider(
      orgId,
      "openai-api-key",
      "gpt-5.4-mini",
    );

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "codex",
      false,
      "openai-api-key",
    );

    expect(result.resolvedModelProvider).toBe("openai-api-key");
    expect(result.framework).toBe("codex");
    expect(result.selectedModel).toBe("gpt-5.4-mini");
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
      userId,
      "claude-code",
      false,
      undefined,
      modelProviderId,
    );

    expect(result.resolvedModelProvider).toBe("openai-api-key");
    expect(result.framework).toBe("codex");
  });
});
