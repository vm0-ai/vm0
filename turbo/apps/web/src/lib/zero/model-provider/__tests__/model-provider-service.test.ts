import { describe, it, expect, beforeEach } from "vitest";
import { isBadRequest } from "@vm0/api-services/errors";
import {
  testContext,
  uniqueId,
  insertOrgCacheEntry,
  ensureOrgRow,
} from "../../../../__tests__/test-helpers";
import {
  createTestUserModelProvider,
  createTestUserMultiAuthModelProvider,
  createTestOrgModelProvider,
} from "../../../../__tests__/api-test-helpers";
import { ORG_SENTINEL_USER_ID } from "../../org/org-sentinel";
// eslint-disable-next-line web/no-direct-db-in-tests -- Personal-tier (BYOK) HTTP routes land in Wave 2 of Epic #11868; this issue only ships service-layer exports, so the privacy invariant + vm0 validation can only be verified at the service boundary until then.
import {
  // Org-tier (existing) — used for cross-tier tests
  upsertOrgNoSecretModelProvider,
  upsertOrgModelProvider,
  // User-tier (new in this issue)
  listUserModelProviders,
  upsertUserModelProvider,
  deleteUserModelProvider,
  setUserModelProviderDefault,
  updateUserModelProviderModel,
  getUserDefaultModelProvider,
  getUserAnyDefaultModelProvider,
  getUserModelProviderByType,
  // Generic core — directly tested for vm0 defense-in-depth
  getModelProviderById,
} from "../model-provider-service";

const context = testContext();

/**
 * Set up a fresh org with two distinct user IDs (alice + bob) sharing the
 * same orgId. The default `context.setupUser()` creates one (orgId, userId)
 * pair where orgId is derived from userId — for cross-user privacy tests we
 * need both users in the SAME org.
 */
async function setupTwoUserOrg(): Promise<{
  orgId: string;
  alice: string;
  bob: string;
}> {
  const suffix = uniqueId("two-user");
  const orgId = `org_${suffix}`;
  const alice = `user_alice_${suffix}`;
  const bob = `user_bob_${suffix}`;
  await insertOrgCacheEntry({ orgId, slug: `org-${suffix}` });
  await ensureOrgRow(orgId);
  return { orgId, alice, bob };
}

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

    it("rejects vm0 with badRequest at the user tier", async () => {
      const { orgId, userId } = await context.setupUser();

      await expect(
        upsertUserModelProvider(orgId, userId, "vm0", ""),
      ).rejects.toSatisfy((err: unknown) => {
        return (
          isBadRequest(err) &&
          err.message.includes("VM0 managed provider is org-only")
        );
      });
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
  // Privacy invariant — the centerpiece of this issue
  // ---------------------------------------------------------------------------

  describe("getModelProviderById — privacy invariant (Epic #11868 Decision 1)", () => {
    it("returns an org-tier row to any caller in the org", async () => {
      const { orgId, alice } = await setupTwoUserOrg();
      const { provider } = await upsertOrgModelProvider(
        orgId,
        "anthropic-api-key",
        "org-key",
      );

      const row = await getModelProviderById(orgId, alice, provider.id);
      expect(row?.type).toBe("anthropic-api-key");
    });

    it("returns alice's user-tier row to alice", async () => {
      const { orgId, alice } = await setupTwoUserOrg();
      const { provider } = await upsertUserModelProvider(
        orgId,
        alice,
        "openai-api-key",
        "alice-key",
      );

      const row = await getModelProviderById(orgId, alice, provider.id);
      expect(row?.type).toBe("openai-api-key");
    });

    it("returns null when bob queries alice's user-tier id (privacy invariant)", async () => {
      const { orgId, alice, bob } = await setupTwoUserOrg();
      const { provider } = await upsertUserModelProvider(
        orgId,
        alice,
        "openai-api-key",
        "alice-key",
      );

      const row = await getModelProviderById(orgId, bob, provider.id);
      expect(row).toBeNull();
    });

    it("returns null when caller is in a different org", async () => {
      const { orgId, alice } = await setupTwoUserOrg();
      const { provider } = await upsertOrgModelProvider(
        orgId,
        "anthropic-api-key",
        "org-key",
      );

      const row = await getModelProviderById("org_other", alice, provider.id);
      expect(row).toBeNull();
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
