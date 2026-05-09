import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveModelProviderSecrets,
  resolveModelRoute,
} from "../resolve-model-provider";
import {
  isBadRequest,
  isModelProviderConnectRequired,
  isNoModelProvider,
  isProviderDeleted,
  isStaleProvider,
} from "@vm0/api-services/errors";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import {
  createTestOrg,
  insertOrgDefaultModelProvider,
  insertOrgNonDefaultModelProvider,
  insertOrgMultiAuthModelProvider,
  insertUserDefaultModelProvider,
  insertUserMultiAuthModelProvider,
  insertUserNonDefaultModelProvider,
  enablePersonalModelProviderForUser,
  enableModelFirstModelProviderForUser,
  insertOrgModelPolicy,
  insertVm0ApiKeys,
  deleteInsertedVm0ApiKeys,
  setTestModelProviderNeedsReconnect,
  ORG_SENTINEL_USER_ID,
} from "../../../../__tests__/api-test-helpers";
import { getTestModelProviderIdByType } from "../../../../__tests__/db-test-assertions/org";
import { mockClerk } from "../../../../__tests__/clerk-mock";
import {
  insertTestOrgModelProviderSecret,
  insertTestUserModelProviderSecret,
} from "../../../../__tests__/db-test-seeders/secrets";

const context = testContext();

afterEach(async () => {
  await deleteInsertedVm0ApiKeys();
});

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

  it("filters serverOnly secrets out of the runner-bound map for codex-oauth-token (#11878)", async () => {
    // Epic constraint #7365: refresh tokens and id tokens MUST stay
    // server-side; they cannot leak into the sandbox via ExecutionContext.
    // The codex-oauth-token registry marks CHATGPT_REFRESH_TOKEN and
    // CHATGPT_ID_TOKEN as serverOnly; the resolver filter drops them from
    // the result.secrets map before it flows into the runner job context.
    const userId = uniqueId("codex-oauth-leak");
    const orgId = await setupOrg(userId);
    await insertOrgMultiAuthModelProvider(
      orgId,
      "codex-oauth-token",
      "auth_json",
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

    expect(result.resolvedModelProvider).toBe("codex-oauth-token");
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

  it("resolves a route whose provider framework overrides the compose framework", async () => {
    const userId = uniqueId("route-cross-framework");
    const orgId = await setupOrg(userId);
    await insertOrgDefaultModelProvider(orgId, "openai-api-key");
    const modelProviderId = await getTestModelProviderIdByType(
      orgId,
      "openai-api-key",
    );

    const route = await resolveModelRoute({
      orgId,
      userId,
      framework: "claude-code",
      modelProviderId,
    });

    expect(route.provider.type).toBe("openai-api-key");
    expect(route.framework).toBe("codex");
    expect(route.model.canonical).toBe("gpt-5.5");
    expect(route.model.runtime).toBe("gpt-5.5");
    expect(route.credential).toEqual({
      scope: "org",
      modelProviderId,
      ownerUserId: ORG_SENTINEL_USER_ID,
    });
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

  it("resolves a personal default route with member-owned credentials", async () => {
    const userId = uniqueId("personal-route");
    const orgId = await setupOrg(userId);
    await enablePersonalModelProviderForUser(orgId, userId);
    const modelProviderId = await insertUserDefaultModelProvider(
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

    const route = await resolveModelRoute({
      orgId,
      userId,
      framework: "claude-code",
      preferPersonalProvider: true,
    });

    expect(route.provider.type).toBe("openai-api-key");
    expect(route.framework).toBe("codex");
    expect(route.model.canonical).toBe("gpt-5.4");
    expect(route.credential).toEqual({
      scope: "member",
      modelProviderId,
      ownerUserId: userId,
    });
  });
});

describe("resolveModelProviderSecrets — secretConnectorMap emission (#11908)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("emits CHATGPT_ACCESS_TOKEN → 'codex-oauth' for codex-oauth-token", async () => {
    const userId = uniqueId("scm-chatgpt");
    const orgId = await setupOrg(userId);
    await insertOrgMultiAuthModelProvider(
      orgId,
      "codex-oauth-token",
      "auth_json",
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
      CHATGPT_ACCESS_TOKEN: "codex-oauth",
    });
    expect(result.secretConnectorMetadataMap).toEqual({
      CHATGPT_ACCESS_TOKEN: {
        sourceType: "model-provider",
        sourceUserId: ORG_SENTINEL_USER_ID,
        metadataKey: "codex-oauth-token",
      },
    });
  });

  it("emits user-tier owner metadata for personal codex-oauth-token", async () => {
    const userId = uniqueId("scm-chatgpt-personal");
    const orgId = await setupOrg(userId);
    await enablePersonalModelProviderForUser(orgId, userId);
    await insertUserMultiAuthModelProvider(
      orgId,
      userId,
      "codex-oauth-token",
      "auth_json",
    );
    for (const [name, value] of [
      ["CHATGPT_ACCESS_TOKEN", "personal-at"],
      ["CHATGPT_REFRESH_TOKEN", "personal-rt"],
      ["CHATGPT_ACCOUNT_ID", "personal-acc"],
      ["CHATGPT_ID_TOKEN", "personal-id"],
    ] as const) {
      await insertTestUserModelProviderSecret({ orgId, userId, name, value });
    }

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

    expect(result.secretConnectorMap).toEqual({
      CHATGPT_ACCESS_TOKEN: "codex-oauth",
    });
    expect(result.secretConnectorMetadataMap).toEqual({
      CHATGPT_ACCESS_TOKEN: {
        sourceType: "model-provider",
        sourceUserId: userId,
        metadataKey: "codex-oauth-token",
      },
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

  it("does not emit secretConnectorMap when codex-oauth-token is missing required secrets", async () => {
    const userId = uniqueId("scm-chatgpt-incomplete");
    const orgId = await setupOrg(userId);
    await insertOrgMultiAuthModelProvider(
      orgId,
      "codex-oauth-token",
      "auth_json",
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

describe("resolveModelProviderSecrets — stale-provider gate (#11932)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("throws staleProvider when matching provider has needsReconnect=true", async () => {
    const userId = uniqueId("stale-chatgpt");
    const orgId = await setupOrg(userId);
    await insertOrgMultiAuthModelProvider(
      orgId,
      "codex-oauth-token",
      "auth_json",
    );
    for (const [name, value] of [
      ["CHATGPT_ACCESS_TOKEN", "at"],
      ["CHATGPT_REFRESH_TOKEN", "rt"],
      ["CHATGPT_ACCOUNT_ID", "acct"],
      ["CHATGPT_ID_TOKEN", "idt"],
    ] as const) {
      await insertTestOrgModelProviderSecret({ orgId, name, value });
    }
    await setTestModelProviderNeedsReconnect(
      orgId,
      ORG_SENTINEL_USER_ID,
      "codex-oauth-token",
      true,
      "refresh_token_expired",
    );

    await expect(
      resolveModelProviderSecrets(orgId, userId, "codex", false),
    ).rejects.toSatisfy((err: unknown) => {
      if (!isStaleProvider(err)) return false;
      return (
        err.providerType === "codex-oauth-token" &&
        err.refreshErrorCode === "refresh_token_expired"
      );
    });
  });

  it("does not throw when needsReconnect=false (healthy provider)", async () => {
    const userId = uniqueId("healthy-chatgpt");
    const orgId = await setupOrg(userId);
    await insertOrgMultiAuthModelProvider(
      orgId,
      "codex-oauth-token",
      "auth_json",
    );
    for (const [name, value] of [
      ["CHATGPT_ACCESS_TOKEN", "at"],
      ["CHATGPT_REFRESH_TOKEN", "rt"],
      ["CHATGPT_ACCOUNT_ID", "acct"],
      ["CHATGPT_ID_TOKEN", "idt"],
    ] as const) {
      await insertTestOrgModelProviderSecret({ orgId, name, value });
    }

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "codex",
      false,
    );
    expect(result.resolvedModelProvider).toBe("codex-oauth-token");
  });
});

describe("resolveModelProviderSecrets — model-first policy (#12130)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("uses the org model policy default field for workspace default when switch is on", async () => {
    const userId = uniqueId("mf-default");
    const orgId = await setupOrg(userId);
    await enableModelFirstModelProviderForUser(orgId, userId);
    await insertVm0ApiKeys([
      {
        vendor: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: "vm0-anthropic-key",
      },
    ]);
    await insertOrgModelPolicy({
      orgId,
      model: "claude-opus-4-6",
    });
    await insertOrgModelPolicy({
      orgId,
      model: "claude-sonnet-4-6",
      isDefault: true,
    });

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "claude-code",
      false,
    );

    expect(result.resolvedModelProvider).toBe("vm0");
    expect(result.selectedModel).toBe("claude-sonnet-4-6");
    expect(result.credentialScope).toBe("org");
    expect(result.secrets?.ANTHROPIC_API_KEY).toEqual(expect.any(String));
  });

  it("uses org-scoped API-key routes without member credentials and injects runtime model aliases", async () => {
    const userId = uniqueId("mf-org-api-key");
    const orgId = await setupOrg(userId);
    await enableModelFirstModelProviderForUser(orgId, userId);
    await insertOrgNonDefaultModelProvider(orgId, "openrouter-api-key");
    const providerId = await getTestModelProviderIdByType(
      orgId,
      "openrouter-api-key",
    );
    await insertTestOrgModelProviderSecret({
      orgId,
      name: "OPENROUTER_API_KEY",
      value: "org-openrouter-key",
    });
    await insertOrgModelPolicy({
      orgId,
      model: "glm-5.1",
      defaultProviderType: "openrouter-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    });

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "claude-code",
      false,
      undefined,
      undefined,
      "glm-5.1",
    );

    expect(result.resolvedModelProvider).toBe("openrouter-api-key");
    expect(result.modelProviderId).toBe(providerId);
    expect(result.selectedModel).toBe("glm-5.1");
    expect(result.secrets?.OPENROUTER_API_KEY).toBe("org-openrouter-key");
    expect(result.injectedEnvironment?.ANTHROPIC_MODEL).toBe("z-ai/glm-5.1");
  });

  it("resolves model-first org API-key routes into route framework/model/credential", async () => {
    const userId = uniqueId("mf-route-org");
    const orgId = await setupOrg(userId);
    await enableModelFirstModelProviderForUser(orgId, userId);
    await insertOrgNonDefaultModelProvider(orgId, "openrouter-api-key");
    const providerId = await getTestModelProviderIdByType(
      orgId,
      "openrouter-api-key",
    );
    await insertOrgModelPolicy({
      orgId,
      model: "glm-5.1",
      isDefault: true,
      defaultProviderType: "openrouter-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    });

    const route = await resolveModelRoute({
      orgId,
      userId,
      framework: "codex",
      selectedModelOverride: "glm-5.1",
    });

    expect(route.provider.type).toBe("openrouter-api-key");
    expect(route.framework).toBe("claude-code");
    expect(route.model).toEqual({
      selected: "glm-5.1",
      canonical: "glm-5.1",
      runtime: "z-ai/glm-5.1",
    });
    expect(route.credential).toEqual({
      scope: "org",
      modelProviderId: providerId,
      ownerUserId: ORG_SENTINEL_USER_ID,
    });
  });

  it("uses the current member's OAuth credential for member-scoped routes", async () => {
    const userId = uniqueId("mf-member-oauth");
    const orgId = await setupOrg(userId);
    await enableModelFirstModelProviderForUser(orgId, userId);
    await insertUserMultiAuthModelProvider(
      orgId,
      userId,
      "codex-oauth-token",
      "auth_json",
    );
    for (const [name, value] of [
      ["CHATGPT_ACCESS_TOKEN", "member-access"],
      ["CHATGPT_REFRESH_TOKEN", "member-refresh"],
      ["CHATGPT_ACCOUNT_ID", "member-account"],
      ["CHATGPT_ID_TOKEN", "member-id"],
    ] as const) {
      await insertTestUserModelProviderSecret({ orgId, userId, name, value });
    }
    await insertOrgModelPolicy({
      orgId,
      model: "gpt-5.5",
      defaultProviderType: "codex-oauth-token",
      credentialScope: "member",
    });

    const result = await resolveModelProviderSecrets(
      orgId,
      userId,
      "codex",
      false,
      undefined,
      undefined,
      "gpt-5.5",
    );

    expect(result.resolvedModelProvider).toBe("codex-oauth-token");
    expect(result.credentialScope).toBe("member");
    expect(result.modelProviderId).toBeNull();
    expect(result.secrets).toEqual({
      CHATGPT_ACCESS_TOKEN: "member-access",
      CHATGPT_ACCOUNT_ID: "member-account",
    });
    expect(result.injectedEnvironment?.OPENAI_MODEL).toBe("gpt-5.5");
  });

  it("resolves model-first member OAuth routes into member-owned Codex routes", async () => {
    const userId = uniqueId("mf-route-member");
    const orgId = await setupOrg(userId);
    await enableModelFirstModelProviderForUser(orgId, userId);
    await insertUserMultiAuthModelProvider(
      orgId,
      userId,
      "codex-oauth-token",
      "auth_json",
    );
    await insertOrgModelPolicy({
      orgId,
      model: "gpt-5.5",
      isDefault: true,
      defaultProviderType: "codex-oauth-token",
      credentialScope: "member",
    });

    const route = await resolveModelRoute({
      orgId,
      userId,
      framework: "claude-code",
      selectedModelOverride: "gpt-5.5",
    });

    expect(route.provider.type).toBe("codex-oauth-token");
    expect(route.framework).toBe("codex");
    expect(route.model.runtime).toBe("gpt-5.5");
    expect(route.credential).toEqual({
      scope: "member",
      modelProviderId: null,
      ownerUserId: userId,
    });
  });

  it("throws connect-required for missing member OAuth and does not fallback", async () => {
    const userId = uniqueId("mf-missing-oauth");
    const orgId = await setupOrg(userId);
    await enableModelFirstModelProviderForUser(orgId, userId);
    await insertOrgModelPolicy({
      orgId,
      model: "gpt-5.5",
      defaultProviderType: "codex-oauth-token",
      credentialScope: "member",
    });

    await expect(
      resolveModelProviderSecrets(
        orgId,
        userId,
        "codex",
        false,
        undefined,
        undefined,
        "gpt-5.5",
      ),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        isModelProviderConnectRequired(err) &&
        err.providerType === "codex-oauth-token"
      );
    });
  });

  it("throws stale-provider for stale member OAuth routes", async () => {
    const userId = uniqueId("mf-stale-oauth");
    const orgId = await setupOrg(userId);
    await enableModelFirstModelProviderForUser(orgId, userId);
    await insertUserMultiAuthModelProvider(
      orgId,
      userId,
      "codex-oauth-token",
      "auth_json",
    );
    await setTestModelProviderNeedsReconnect(
      orgId,
      userId,
      "codex-oauth-token",
      true,
      "refresh_token_expired",
    );
    await insertOrgModelPolicy({
      orgId,
      model: "gpt-5.5",
      defaultProviderType: "codex-oauth-token",
      credentialScope: "member",
    });

    await expect(
      resolveModelProviderSecrets(
        orgId,
        userId,
        "codex",
        false,
        undefined,
        undefined,
        "gpt-5.5",
      ),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        isStaleProvider(err) &&
        err.providerType === "codex-oauth-token" &&
        err.refreshErrorCode === "refresh_token_expired"
      );
    });
  });

  it("rejects unconfigured model selections", async () => {
    const userId = uniqueId("mf-unconfigured");
    const orgId = await setupOrg(userId);
    await enableModelFirstModelProviderForUser(orgId, userId);

    await expect(
      resolveModelProviderSecrets(
        orgId,
        userId,
        "codex",
        false,
        undefined,
        undefined,
        "glm-5.1",
      ),
    ).rejects.toSatisfy((err: unknown) => {
      return isBadRequest(err);
    });
  });

  it("throws providerDeleted for pinned org API-key routes whose provider row is gone", async () => {
    const userId = uniqueId("mf-deleted-provider");
    const orgId = await setupOrg(userId);
    await enableModelFirstModelProviderForUser(orgId, userId);
    await insertOrgModelPolicy({
      orgId,
      model: "gpt-5.5",
    });

    await expect(
      resolveModelProviderSecrets(
        orgId,
        userId,
        "codex",
        false,
        "openai-api-key",
        "00000000-0000-0000-0000-000000000001",
        "gpt-5.5",
        undefined,
        "org",
      ),
    ).rejects.toSatisfy((err: unknown) => {
      return isProviderDeleted(err);
    });
  });

  it("rejects vm0 model routes during materialization when no key is available", async () => {
    const userId = uniqueId("mf-vm0-missing-key");
    const orgId = await setupOrg(userId);
    await enableModelFirstModelProviderForUser(orgId, userId);
    await insertOrgModelPolicy({
      orgId,
      model: "deepseek-v4-pro",
      isDefault: true,
      defaultProviderType: "vm0",
      credentialScope: "org",
    });

    await expect(
      resolveModelProviderSecrets(
        orgId,
        userId,
        "codex",
        false,
        undefined,
        undefined,
        "deepseek-v4-pro",
      ),
    ).rejects.toSatisfy((err: unknown) => {
      return isBadRequest(err);
    });
  });

  it("ignores model policies when the switch is off", async () => {
    const userId = uniqueId("mf-switch-off");
    const orgId = await setupOrg(userId);
    await insertOrgModelPolicy({
      orgId,
      model: "gpt-5.5",
    });

    await expect(
      resolveModelProviderSecrets(orgId, userId, "codex", false),
    ).rejects.toSatisfy((err: unknown) => {
      return isNoModelProvider(err);
    });
  });
});
