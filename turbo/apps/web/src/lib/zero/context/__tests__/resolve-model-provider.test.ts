import { describe, it, expect, beforeEach } from "vitest";
import { resolveModelProviderSecrets } from "../resolve-model-provider";
import { isNoModelProvider } from "@vm0/api-services/errors";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import {
  createTestOrg,
  insertOrgDefaultModelProvider,
  insertOrgNonDefaultModelProvider,
  insertOrgMultiAuthModelProvider,
  insertUserDefaultModelProvider,
  insertUserNonDefaultModelProvider,
  enablePersonalModelProviderForUser,
} from "../../../../__tests__/api-test-helpers";
import { getTestModelProviderIdByType } from "../../../../__tests__/db-test-assertions/org";
import { mockClerk } from "../../../../__tests__/clerk-mock";
import {
  insertTestOrgModelProviderSecret,
  insertTestUserModelProviderSecret,
} from "../../../../__tests__/db-test-seeders/secrets";

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

  it("filters serverOnly secrets out of the runner-bound map for chatgpt-oauth-token (#11878)", async () => {
    // Epic constraint #7365: refresh tokens and id tokens MUST stay
    // server-side; they cannot leak into the sandbox via ExecutionContext.
    // The chatgpt-oauth-token registry marks CHATGPT_REFRESH_TOKEN and
    // CHATGPT_ID_TOKEN as serverOnly; the resolver filter drops them from
    // the result.secrets map before it flows into the runner job context.
    const userId = uniqueId("chatgpt-oauth-leak");
    const orgId = await setupOrg(userId);
    await insertOrgMultiAuthModelProvider(
      orgId,
      "chatgpt-oauth-token",
      "oauth",
    );
    for (const [name, value] of [
      ["CHATGPT_ACCESS_TOKEN", "real-access"],
      ["CHATGPT_REFRESH_TOKEN", "real-refresh-server-only"],
      ["CHATGPT_ACCOUNT_ID", "ws_real_account"],
      ["CHATGPT_ID_TOKEN", "real-id-server-only"],
    ] as const) {
      await insertTestOrgModelProviderSecret({ orgId, name, value });
    }

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "codex",
      false,
    );

    expect(result.resolvedModelProvider).toBe("chatgpt-oauth-token");
    expect(result.framework).toBe("codex");
    expect(result.secrets).toBeDefined();
    expect(Object.keys(result.secrets!).sort()).toEqual([
      "CHATGPT_ACCESS_TOKEN",
      "CHATGPT_ACCOUNT_ID",
    ]);
    expect(result.secrets!.CHATGPT_REFRESH_TOKEN).toBeUndefined();
    expect(result.secrets!.CHATGPT_ID_TOKEN).toBeUndefined();
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

describe("resolveModelProviderSecrets — personal tier (#11899)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("falls through to org chain when personal feature switch is OFF (default)", async () => {
    // Switch is staff-only by default and the test org is not staff. Even
    // with `preferPersonalProvider=true`, the gate evaluates to false and
    // the resolver behaves identically to today's org-only flow.
    const userId = uniqueId("personal-switch-off");
    const orgId = await setupOrg(userId);
    await insertUserDefaultModelProvider(
      orgId,
      userId,
      "openai-api-key",
      "gpt-5.4",
    );
    await insertOrgDefaultModelProvider(
      orgId,
      "anthropic-api-key",
      "claude-sonnet-4-6",
    );

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "claude-code",
      false,
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(result.resolvedModelProvider).toBe("anthropic-api-key");
    expect(result.framework).toBe("claude-code");
  });

  it("falls through to org chain when switch is ON but flag is OFF", async () => {
    const userId = uniqueId("personal-flag-off");
    const orgId = await setupOrg(userId);
    await enablePersonalModelProviderForUser(orgId, userId);
    await insertUserDefaultModelProvider(
      orgId,
      userId,
      "openai-api-key",
      "gpt-5.4",
    );
    await insertOrgDefaultModelProvider(
      orgId,
      "anthropic-api-key",
      "claude-sonnet-4-6",
    );

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "claude-code",
      false,
      undefined,
      undefined,
      undefined,
      false,
    );

    expect(result.resolvedModelProvider).toBe("anthropic-api-key");
    expect(result.framework).toBe("claude-code");
  });

  it("returns user's personal default + secret when switch ON, flag ON, framework match", async () => {
    // Verifies both that the resolver picks the personal row AND that
    // `secretUserId` was derived from the row's owner — otherwise the
    // secrets table lookup would miss the personal-tier row and fall back
    // to whatever the org has under `OPENAI_API_KEY`.
    const userId = uniqueId("personal-match");
    const orgId = await setupOrg(userId);
    await enablePersonalModelProviderForUser(orgId, userId);
    await insertUserDefaultModelProvider(
      orgId,
      userId,
      "openai-api-key",
      "gpt-5.4",
    );
    await insertTestUserModelProviderSecret({
      orgId,
      userId,
      name: "OPENAI_API_KEY",
      value: "personal-secret-value",
    });
    await insertOrgDefaultModelProvider(orgId, "openai-api-key", "gpt-5.5");
    await insertTestOrgModelProviderSecret({
      orgId,
      name: "OPENAI_API_KEY",
      value: "org-secret-value",
    });

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "codex",
      false,
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(result.resolvedModelProvider).toBe("openai-api-key");
    expect(result.framework).toBe("codex");
    expect(result.selectedModel).toBe("gpt-5.4");
    expect(result.secrets?.OPENAI_API_KEY).toBe("personal-secret-value");
  });

  it("uses cross-framework user fallback when no personal row matches the compose framework", async () => {
    // User has only a codex-framework personal default; compose asks for
    // claude-code. Cross-framework fallback (`getUserAnyDefaultModelProvider`)
    // must surface it and the provider's framework propagates downstream
    // (Epic #11520 — provider's framework wins).
    const userId = uniqueId("personal-cross-fw");
    const orgId = await setupOrg(userId);
    await enablePersonalModelProviderForUser(orgId, userId);
    await insertUserDefaultModelProvider(
      orgId,
      userId,
      "openai-api-key",
      "gpt-5.4",
    );

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "claude-code",
      false,
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(result.resolvedModelProvider).toBe("openai-api-key");
    expect(result.framework).toBe("codex");
  });

  it("falls through to org chain when user has no personal rows", async () => {
    const userId = uniqueId("personal-empty");
    const orgId = await setupOrg(userId);
    await enablePersonalModelProviderForUser(orgId, userId);
    await insertOrgDefaultModelProvider(
      orgId,
      "anthropic-api-key",
      "claude-sonnet-4-6",
    );

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "claude-code",
      false,
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(result.resolvedModelProvider).toBe("anthropic-api-key");
    expect(result.framework).toBe("claude-code");
  });

  it("explicit type override consults user-tier first when personalEligible", async () => {
    // Workspace default is org's `claude-code-oauth-token`. Request
    // explicitly asks for `openai-api-key`. User has a personal
    // `openai-api-key` row whose stored selectedModel must surface — and
    // the secret must come from the personal row, not the org's.
    const userId = uniqueId("personal-explicit-type");
    const orgId = await setupOrg(userId);
    await enablePersonalModelProviderForUser(orgId, userId);
    await insertOrgDefaultModelProvider(
      orgId,
      "claude-code-oauth-token",
      "claude-sonnet-4-6",
    );
    await insertUserNonDefaultModelProvider(
      orgId,
      userId,
      "openai-api-key",
      "gpt-5.4-mini",
    );
    await insertTestUserModelProviderSecret({
      orgId,
      userId,
      name: "OPENAI_API_KEY",
      value: "personal-openai-key",
    });
    await insertOrgNonDefaultModelProvider(orgId, "openai-api-key", "gpt-5.5");
    await insertTestOrgModelProviderSecret({
      orgId,
      name: "OPENAI_API_KEY",
      value: "org-openai-key",
    });

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "codex",
      false,
      "openai-api-key",
      undefined,
      undefined,
      true,
    );

    expect(result.resolvedModelProvider).toBe("openai-api-key");
    expect(result.framework).toBe("codex");
    expect(result.selectedModel).toBe("gpt-5.4-mini");
    expect(result.secrets?.OPENAI_API_KEY).toBe("personal-openai-key");
  });

  it("modelProviderId pin to user-tier row routes secret lookup to that user", async () => {
    // When the request pins a specific user-tier providerId,
    // `getModelProviderById` returns it (user-aware), and `secretUserId`
    // must derive from the row's owner so the secret is fetched from the
    // user's secrets, not the org sentinel's.
    const userId = uniqueId("personal-pin");
    const orgId = await setupOrg(userId);
    await enablePersonalModelProviderForUser(orgId, userId);
    const providerId = await insertUserNonDefaultModelProvider(
      orgId,
      userId,
      "openai-api-key",
      "gpt-5.4",
    );
    await insertTestUserModelProviderSecret({
      orgId,
      userId,
      name: "OPENAI_API_KEY",
      value: "personal-pin-key",
    });
    await insertOrgDefaultModelProvider(
      orgId,
      "anthropic-api-key",
      "claude-sonnet-4-6",
    );

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "claude-code",
      false,
      undefined,
      providerId,
      undefined,
      true,
    );

    expect(result.resolvedModelProvider).toBe("openai-api-key");
    expect(result.framework).toBe("codex");
    expect(result.secrets?.OPENAI_API_KEY).toBe("personal-pin-key");
  });
});

describe("resolveModelProviderSecrets — secretConnectorMap emission (#11908)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("emits CHATGPT_ACCESS_TOKEN → 'chatgpt-oauth' for chatgpt-oauth-token", async () => {
    const userId = uniqueId("scm-chatgpt");
    const orgId = await setupOrg(userId);
    await insertOrgMultiAuthModelProvider(
      orgId,
      "chatgpt-oauth-token",
      "oauth",
    );
    for (const [name, value] of [
      ["CHATGPT_ACCESS_TOKEN", "at-1"],
      ["CHATGPT_REFRESH_TOKEN", "rt-1"],
      ["CHATGPT_ACCOUNT_ID", "ws_acc"],
      ["CHATGPT_ID_TOKEN", "id-1"],
    ] as const) {
      await insertTestOrgModelProviderSecret({ orgId, name, value });
    }

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "codex",
      false,
    );

    expect(result.secretConnectorMap).toEqual({
      CHATGPT_ACCESS_TOKEN: "chatgpt-oauth",
    });
  });

  it("returns undefined secretConnectorMap for openai-api-key (no refreshToken on handler)", async () => {
    const userId = uniqueId("scm-openai");
    const orgId = await setupOrg(userId);
    await insertOrgDefaultModelProvider(orgId, "openai-api-key");

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "codex",
      false,
    );

    expect(result.secretConnectorMap).toBeUndefined();
  });

  it("does not emit secretConnectorMap when chatgpt-oauth-token is missing required secrets", async () => {
    const userId = uniqueId("scm-chatgpt-incomplete");
    const orgId = await setupOrg(userId);
    await insertOrgMultiAuthModelProvider(
      orgId,
      "chatgpt-oauth-token",
      "oauth",
    );
    // Only seed access token; refresh/account/id missing → resolver returns
    // the no-secrets fallback path; no secretConnectorMap.
    await insertTestOrgModelProviderSecret({
      orgId,
      name: "CHATGPT_ACCESS_TOKEN",
      value: "at-1",
    });

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "codex",
      false,
    );

    expect(result.secretConnectorMap).toBeUndefined();
  });
});
