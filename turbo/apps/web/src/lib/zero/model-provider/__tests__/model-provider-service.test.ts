import { describe, it, expect, beforeEach } from "vitest";
import { testContext } from "../../../../__tests__/test-helpers";
import {
  createTestUserModelProvider,
  createTestUserMultiAuthModelProvider,
  createTestOrgModelProvider,
  findTestModelProviderTokenState,
  setTestModelProviderNeedsReconnect,
} from "../../../../__tests__/api-test-helpers";
import { ORG_SENTINEL_USER_ID } from "../../org/org-sentinel";
// eslint-disable-next-line web/no-direct-db-in-tests -- Internal-only resolver helpers (getUserDefaultModelProvider, getUserAnyDefaultModelProvider, getUserModelProviderByType) have no HTTP entry point — they are consumed by the Wave 3 resolver. Cross-tier defense (org-tier vm0 unaffected by user-tier additions) likewise has no user-facing route. Privacy + vm0 user-tier assertions migrated to route-level tests in Wave 2 (#11898).
import {
  // Org-tier (existing) — used for cross-tier defense tests
  upsertOrgNoSecretModelProvider,
  upsertOrgMultiAuthModelProvider,
  // User-tier (added in #11874)
  listUserModelProviders,
  upsertUserModelProvider,
  deleteUserModelProvider,
  setUserModelProviderDefault,
  updateUserModelProviderModel,
  getUserDefaultModelProvider,
  getUserAnyDefaultModelProvider,
  getUserModelProviderByType,
  // Generic core — used for cross-tier defense (org default unaffected)
  getModelProviderById,
} from "../model-provider-service";

const context = testContext();

describe("model-provider-service — user-tier", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  // ---------------------------------------------------------------------------
  // Happy paths for the new user-tier exports
  // ---------------------------------------------------------------------------

  describe("upsertUserModelProvider", () => {
    it("creates a user-tier provider scoped to (orgId, userId)", async () => {
      const { orgId, userId } = await context.setupUser();

      const { provider, created } = await upsertUserModelProvider(
        orgId,
        userId,
        "anthropic-api-key",
        "sk-ant-test",
      );

      expect(created).toBe(true);
      expect(provider.type).toBe("anthropic-api-key");
      expect(provider.framework).toBe("claude-code");
      expect(provider.secretName).toBe("ANTHROPIC_API_KEY");
      expect(provider.isDefault).toBe(true);
    });

    it("does not affect vm0 org-tier upsert (no behavior change)", async () => {
      const { orgId } = await context.setupUser();

      const { provider } = await upsertOrgNoSecretModelProvider(orgId, "vm0");

      expect(provider.type).toBe("vm0");
      expect(provider.isDefault).toBe(true);
    });
  });

  describe("upsertUserMultiAuthModelProvider", () => {
    it("creates a user-tier multi-auth provider (aws-bedrock)", async () => {
      const { orgId, userId } = await context.setupUser();

      const provider = await createTestUserMultiAuthModelProvider(
        orgId,
        userId,
        "aws-bedrock",
        "access-keys",
        {
          AWS_ACCESS_KEY_ID: "test-access-key",
          AWS_SECRET_ACCESS_KEY: "test-secret-key",
          AWS_REGION: "us-east-1",
        },
      );

      expect(provider.type).toBe("aws-bedrock");
      expect(provider.authMethod).toBe("access-keys");
      expect(provider.secretNames).toContain("AWS_ACCESS_KEY_ID");
      expect(provider.isDefault).toBe(true);
    });
  });

  describe("listUserModelProviders", () => {
    it("returns only the user's providers, not the org's", async () => {
      const { orgId, userId } = await context.setupUser();

      // Seed an org-tier provider in the same org
      await createTestOrgModelProvider("anthropic-api-key", "org-key");
      // Seed alice's personal provider
      await createTestUserModelProvider(
        orgId,
        userId,
        "openai-api-key",
        "user-key",
      );

      const userList = await listUserModelProviders(orgId, userId);
      expect(userList).toHaveLength(1);
      expect(userList[0]!.type).toBe("openai-api-key");
    });
  });

  describe("user-tier and org-tier defaults coexist", () => {
    it("user has is_default=true alongside org is_default=true", async () => {
      const { orgId, userId } = await context.setupUser();

      // Org's first provider becomes org default automatically
      await createTestOrgModelProvider("anthropic-api-key", "org-key");
      // User's first provider becomes user default automatically
      const userProvider = await createTestUserModelProvider(
        orgId,
        userId,
        "openai-api-key",
        "user-key",
      );

      expect(userProvider.isDefault).toBe(true);
      const userDefault = await getUserDefaultModelProvider(
        orgId,
        userId,
        "codex",
      );
      expect(userDefault?.type).toBe("openai-api-key");
    });
  });

  describe("setUserModelProviderDefault", () => {
    it("flips the user's default without touching the org default", async () => {
      const { orgId, userId } = await context.setupUser();

      // Org default — anthropic
      await createTestOrgModelProvider("anthropic-api-key", "org-key");
      // User has two personal providers — anthropic becomes default
      await createTestUserModelProvider(
        orgId,
        userId,
        "anthropic-api-key",
        "user-anthro",
      );
      await createTestUserModelProvider(
        orgId,
        userId,
        "openai-api-key",
        "user-openai",
      );

      const updated = await setUserModelProviderDefault(
        orgId,
        userId,
        "openai-api-key",
      );
      expect(updated.isDefault).toBe(true);
      expect(updated.type).toBe("openai-api-key");

      const userList = await listUserModelProviders(orgId, userId);
      const userAnthro = userList.find((p) => {
        return p.type === "anthropic-api-key";
      });
      expect(userAnthro?.isDefault).toBe(false);
    });
  });

  describe("getUserDefaultModelProvider — framework-scoped", () => {
    it("returns the user's default for the matching framework", async () => {
      const { orgId, userId } = await context.setupUser();

      await createTestUserModelProvider(
        orgId,
        userId,
        "openai-api-key",
        "user-openai",
      );

      const codexDefault = await getUserDefaultModelProvider(
        orgId,
        userId,
        "codex",
      );
      expect(codexDefault?.type).toBe("openai-api-key");

      // Different framework — no match
      const ccDefault = await getUserDefaultModelProvider(
        orgId,
        userId,
        "claude-code",
      );
      expect(ccDefault).toBeNull();
    });
  });

  describe("getUserAnyDefaultModelProvider — cross-framework fallback", () => {
    it("returns the user's default regardless of framework", async () => {
      const { orgId, userId } = await context.setupUser();

      await createTestUserModelProvider(
        orgId,
        userId,
        "openai-api-key",
        "user-openai",
      );

      const anyDefault = await getUserAnyDefaultModelProvider(orgId, userId);
      expect(anyDefault?.type).toBe("openai-api-key");
    });
  });

  describe("getUserModelProviderByType", () => {
    it("returns null for an org-tier row even when type matches", async () => {
      const { orgId, userId } = await context.setupUser();

      // Seed org-tier anthropic but no user-tier — getUserModelProviderByType
      // must scope to (orgId, userId), so the org row must NOT surface here.
      await createTestOrgModelProvider("anthropic-api-key", "org-key");

      const userAnthropic = await getUserModelProviderByType(
        orgId,
        userId,
        "anthropic-api-key",
      );
      expect(userAnthropic).toBeNull();
    });

    it("returns the user's row when it exists", async () => {
      const { orgId, userId } = await context.setupUser();

      await createTestUserModelProvider(
        orgId,
        userId,
        "openai-api-key",
        "user-key",
      );

      const userOpenai = await getUserModelProviderByType(
        orgId,
        userId,
        "openai-api-key",
      );
      expect(userOpenai?.type).toBe("openai-api-key");
    });
  });

  // ---------------------------------------------------------------------------
  // Delete + default promotion
  // ---------------------------------------------------------------------------

  describe("deleteUserModelProvider", () => {
    it("promotes the earliest remaining personal provider when default is deleted", async () => {
      const { orgId, userId } = await context.setupUser();

      // Two personal providers — anthropic created first becomes default
      await createTestUserModelProvider(
        orgId,
        userId,
        "anthropic-api-key",
        "user-anthro",
      );
      await createTestUserModelProvider(
        orgId,
        userId,
        "openai-api-key",
        "user-openai",
      );

      await deleteUserModelProvider(orgId, userId, "anthropic-api-key");

      const remaining = await listUserModelProviders(orgId, userId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.type).toBe("openai-api-key");
      expect(remaining[0]!.isDefault).toBe(true);
    });

    it("does not affect org default when user default is deleted", async () => {
      const { orgId, userId } = await context.setupUser();

      const orgProvider = await createTestOrgModelProvider(
        "anthropic-api-key",
        "org-key",
      );
      await createTestUserModelProvider(
        orgId,
        userId,
        "openai-api-key",
        "user-key",
      );
      await deleteUserModelProvider(orgId, userId, "openai-api-key");

      // Org-tier row untouched
      const orgRow = await getModelProviderById(
        orgId,
        ORG_SENTINEL_USER_ID,
        orgProvider.id,
      );
      expect(orgRow?.isDefault).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // updateUserModelProviderModel
  // ---------------------------------------------------------------------------

  describe("updateUserModelProviderModel", () => {
    it("updates only the selectedModel field", async () => {
      const { orgId, userId } = await context.setupUser();

      await createTestUserModelProvider(
        orgId,
        userId,
        "openai-api-key",
        "user-key",
        "gpt-5",
      );

      const updated = await updateUserModelProviderModel(
        orgId,
        userId,
        "openai-api-key",
        "gpt-5.5",
      );

      expect(updated.selectedModel).toBe("gpt-5.5");
      expect(updated.type).toBe("openai-api-key");
    });
  });
});

describe("upsertOrgMultiAuthModelProvider — OAuth metadata + recovery (#11932)", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("persists tokenExpiresAt + workspaceName + planType when metadata is provided", async () => {
    const { orgId } = await context.setupUser();
    const expiresAt = new Date("2026-12-31T00:00:00Z");

    await upsertOrgMultiAuthModelProvider(
      orgId,
      "codex-oauth-token",
      "oauth",
      {
        CHATGPT_ACCESS_TOKEN: "at",
        CHATGPT_REFRESH_TOKEN: "rt",
        CHATGPT_ACCOUNT_ID: "acct",
        CHATGPT_ID_TOKEN: "idt",
      },
      undefined,
      {
        tokenExpiresAt: expiresAt,
        workspaceName: "Acme Inc",
        planType: "business",
      },
    );

    const state = await findTestModelProviderTokenState(
      orgId,
      ORG_SENTINEL_USER_ID,
      "codex-oauth-token",
    );
    expect(state).not.toBeNull();
    expect(state!.tokenExpiresAt).toEqual(expiresAt);
    expect(state!.workspaceName).toBe("Acme Inc");
    expect(state!.planType).toBe("business");
    expect(state!.needsReconnect).toBe(false);
    expect(state!.lastRefreshErrorCode).toBeNull();
  });

  it("clears needsReconnect + lastRefreshErrorCode atomically when re-upserted with metadata", async () => {
    // Seed: provider exists and is stale (firewall webhook flipped it)
    const { orgId } = await context.setupUser();
    await upsertOrgMultiAuthModelProvider(orgId, "codex-oauth-token", "oauth", {
      CHATGPT_ACCESS_TOKEN: "old-at",
      CHATGPT_REFRESH_TOKEN: "old-rt",
      CHATGPT_ACCOUNT_ID: "acct",
      CHATGPT_ID_TOKEN: "old-idt",
    });
    await setTestModelProviderNeedsReconnect(
      orgId,
      ORG_SENTINEL_USER_ID,
      "codex-oauth-token",
      true,
      "refresh_token_expired",
    );

    // Re-OAuth: callback re-upserts with metadata
    await upsertOrgMultiAuthModelProvider(
      orgId,
      "codex-oauth-token",
      "oauth",
      {
        CHATGPT_ACCESS_TOKEN: "new-at",
        CHATGPT_REFRESH_TOKEN: "new-rt",
        CHATGPT_ACCOUNT_ID: "acct",
        CHATGPT_ID_TOKEN: "new-idt",
      },
      undefined,
      {
        tokenExpiresAt: new Date(Date.now() + 86400_000),
        workspaceName: "Acme Inc",
        planType: "plus",
      },
    );

    const state = await findTestModelProviderTokenState(
      orgId,
      ORG_SENTINEL_USER_ID,
      "codex-oauth-token",
    );
    expect(state!.needsReconnect).toBe(false);
    expect(state!.lastRefreshErrorCode).toBeNull();
    expect(state!.workspaceName).toBe("Acme Inc");
    expect(state!.planType).toBe("plus");
  });

  it("does NOT clobber metadata when re-upserted WITHOUT metadata (selectedModel-only update)", async () => {
    const { orgId } = await context.setupUser();
    await upsertOrgMultiAuthModelProvider(
      orgId,
      "codex-oauth-token",
      "oauth",
      {
        CHATGPT_ACCESS_TOKEN: "at",
        CHATGPT_REFRESH_TOKEN: "rt",
        CHATGPT_ACCOUNT_ID: "acct",
        CHATGPT_ID_TOKEN: "idt",
      },
      "gpt-5.5",
      {
        tokenExpiresAt: new Date("2026-12-31T00:00:00Z"),
        workspaceName: "Acme Inc",
        planType: "plus",
      },
    );

    // Update without metadata (e.g. selectedModel change from settings UI)
    await upsertOrgMultiAuthModelProvider(
      orgId,
      "codex-oauth-token",
      "oauth",
      {
        CHATGPT_ACCESS_TOKEN: "at",
        CHATGPT_REFRESH_TOKEN: "rt",
        CHATGPT_ACCOUNT_ID: "acct",
        CHATGPT_ID_TOKEN: "idt",
      },
      "gpt-5.4",
    );

    const state = await findTestModelProviderTokenState(
      orgId,
      ORG_SENTINEL_USER_ID,
      "codex-oauth-token",
    );
    expect(state!.workspaceName).toBe("Acme Inc");
    expect(state!.planType).toBe("plus");
  });
});
