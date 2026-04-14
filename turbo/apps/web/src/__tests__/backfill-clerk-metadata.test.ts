import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { uniqueId } from "./test-helpers";
import {
  ensureOrgRow,
  deleteOrgRow,
  updateOrgTier,
  updateOrgDefaultAgent,
  getOrgRow,
  insertOrgMembersEntry,
  getOrgMembersEntry,
  deleteOrgMembersEntry,
  getUserRow,
  insertUserRow,
  deleteUserRow,
  getTestDb,
} from "./api-test-helpers";
import { seedTestCompose } from "./db-test-seeders/agents";
import {
  backfillOrgMetadata,
  backfillOrgMembersMetadata,
  backfillUsers,
  newStats,
  MAX_ERRORS,
  type ClerkClient,
  type BackfillStats,
  type Db,
} from "../../scripts/migrations/005-backfill-clerk-metadata/backfill";

// ---------------------------------------------------------------------------
// Mock Clerk client factory
// ---------------------------------------------------------------------------

interface MockOrg {
  id: string;
  publicMetadata: Record<string, unknown>;
}

interface MockMembership {
  publicUserData: { userId: string } | null;
  publicMetadata: Record<string, unknown>;
}

interface MockUser {
  id: string;
  publicMetadata: Record<string, unknown>;
}

function mockClerkClient(opts: {
  orgs?: MockOrg[];
  memberships?: Record<string, MockMembership[]>;
  users?: MockUser[];
}): ClerkClient {
  const orgs = opts.orgs ?? [];
  const memberships = opts.memberships ?? {};
  const clerkUsers = opts.users ?? [];

  return {
    organizations: {
      getOrganizationList: async ({
        limit,
        offset,
      }: {
        limit: number;
        offset: number;
      }) => {
        return {
          data: orgs.slice(offset, offset + limit),
          totalCount: orgs.length,
        };
      },
      getOrganizationMembershipList: async ({
        organizationId,
        limit,
        offset,
      }: {
        organizationId: string;
        limit: number;
        offset: number;
      }) => {
        const members = memberships[organizationId] ?? [];
        return {
          data: members.slice(offset, offset + limit),
          totalCount: members.length,
        };
      },
    },
    users: {
      getUserList: async ({
        limit,
        offset,
      }: {
        limit: number;
        offset: number;
      }) => {
        return {
          data: clerkUsers.slice(offset, offset + limit),
          totalCount: clerkUsers.length,
        };
      },
    },
  } as unknown as ClerkClient;
}

// The test DB (node-postgres) and script DB (postgres-js) have compatible
// Drizzle APIs but different TypeScript types. This helper bridges the gap.
function db(): Db {
  return getTestDb() as unknown as Db;
}

// ---------------------------------------------------------------------------
// Cleanup tracking
// ---------------------------------------------------------------------------

const createdOrgIds: string[] = [];
const createdMemberKeys: Array<{ orgId: string; userId: string }> = [];
const createdUserIds: string[] = [];

function trackOrg(orgId: string): void {
  createdOrgIds.push(orgId);
}

function trackMember(orgId: string, userId: string): void {
  createdMemberKeys.push({ orgId, userId });
}

function trackUser(userId: string): void {
  createdUserIds.push(userId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("backfill-clerk-metadata", () => {
  let stats: BackfillStats;

  beforeEach(() => {
    stats = newStats();
  });

  afterEach(async () => {
    for (const orgId of createdOrgIds) {
      await deleteOrgRow(orgId);
    }
    for (const { orgId, userId } of createdMemberKeys) {
      await deleteOrgMembersEntry(orgId, userId);
    }
    for (const userId of createdUserIds) {
      await deleteUserRow(userId);
    }
    createdOrgIds.length = 0;
    createdMemberKeys.length = 0;
    createdUserIds.length = 0;
  });

  // -------------------------------------------------------------------------
  // Phase 1: org_metadata
  // -------------------------------------------------------------------------

  describe("backfillOrgMetadata", () => {
    it("inserts org_metadata for orgs with non-default Clerk metadata", async () => {
      const orgId = uniqueId("bf-org");
      trackOrg(orgId);

      // Create org row + compose + agent so backfill can resolve compose UUID → agent UUID
      await ensureOrgRow(orgId);
      const userId = uniqueId("bf-user");
      const agentName = uniqueId("bf-agent");
      const { composeId, agentId } = await seedTestCompose({
        userId,
        name: agentName,
        orgId,
      });

      const clerk = mockClerkClient({
        orgs: [
          {
            id: orgId,
            publicMetadata: {
              tier: "pro",
              default_agent_compose_id: composeId,
            },
          },
        ],
      });

      await backfillOrgMetadata(clerk, db(), stats, false);

      const row = await getOrgRow(orgId);
      expect(row).toBeDefined();
      expect(row!.tier).toBe("pro");
      // Backfill resolves compose UUID → zero agent UUID
      expect(row!.defaultAgentId).toBe(agentId);
      expect(stats.orgs.processed).toBe(1);
      expect(stats.orgs.upserted).toBe(1);
      expect(stats.orgs.skipped).toBe(0);
    });

    it("skips orgs with only default metadata", async () => {
      // No trackOrg — backfill skips default-only metadata, nothing written to DB
      const orgId = uniqueId("bf-org-skip");

      const clerk = mockClerkClient({
        orgs: [{ id: orgId, publicMetadata: {} }],
      });

      await backfillOrgMetadata(clerk, db(), stats, false);

      const row = await getOrgRow(orgId);
      expect(row).toBeUndefined();
      expect(stats.orgs.skipped).toBe(1);
    });

    it("preserves non-default DB tier when Clerk has different value", async () => {
      const orgId = uniqueId("bf-org-keep");
      trackOrg(orgId);

      await ensureOrgRow(orgId);
      await updateOrgTier(orgId, "enterprise");

      const clerk = mockClerkClient({
        orgs: [{ id: orgId, publicMetadata: { tier: "pro" } }],
      });

      await backfillOrgMetadata(clerk, db(), stats, false);

      const row = await getOrgRow(orgId);
      expect(row!.tier).toBe("enterprise"); // Not overwritten
    });

    it("updates default tier='free' with Clerk value", async () => {
      const orgId = uniqueId("bf-org-upd");
      trackOrg(orgId);

      await ensureOrgRow(orgId); // tier defaults to "free"

      const clerk = mockClerkClient({
        orgs: [{ id: orgId, publicMetadata: { tier: "pro" } }],
      });

      await backfillOrgMetadata(clerk, db(), stats, false);

      const row = await getOrgRow(orgId);
      expect(row!.tier).toBe("pro"); // Updated from "free" to "pro"
    });

    it("preserves existing defaultAgentId when not null", async () => {
      const orgId = uniqueId("bf-org-cid");
      trackOrg(orgId);

      await ensureOrgRow(orgId);

      // Create a real agent so FK is satisfied
      const userId = uniqueId("bf-user-cid");
      const { agentId: existingAgentId } = await seedTestCompose({
        userId,
        name: uniqueId("bf-existing"),
        orgId,
      });
      await updateOrgDefaultAgent(orgId, existingAgentId);

      // Clerk has a different compose UUID for the same org
      const { composeId: clerkComposeId } = await seedTestCompose({
        userId,
        name: uniqueId("bf-clerk"),
        orgId,
      });

      const clerk = mockClerkClient({
        orgs: [
          {
            id: orgId,
            publicMetadata: {
              tier: "pro",
              default_agent_compose_id: clerkComposeId,
            },
          },
        ],
      });

      await backfillOrgMetadata(clerk, db(), stats, false);

      const row = await getOrgRow(orgId);
      expect(row!.defaultAgentId).toBe(existingAgentId); // Not overwritten
    });

    it("does not write in dry-run mode", async () => {
      const orgId = uniqueId("bf-org-dry");

      const clerk = mockClerkClient({
        orgs: [{ id: orgId, publicMetadata: { tier: "pro" } }],
      });

      await backfillOrgMetadata(clerk, db(), stats, true);

      const row = await getOrgRow(orgId);
      expect(row).toBeUndefined();
      expect(stats.orgs.upserted).toBe(1); // Counted but not written
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2: org_members_metadata
  // -------------------------------------------------------------------------

  describe("backfillOrgMembersMetadata", () => {
    it("inserts member preferences from Clerk metadata", async () => {
      const orgId = uniqueId("bf-mem-org");
      const userId = uniqueId("bf-mem-usr");
      trackMember(orgId, userId);

      const clerk = mockClerkClient({
        orgs: [{ id: orgId, publicMetadata: {} }],
        memberships: {
          [orgId]: [
            {
              publicUserData: { userId },
              publicMetadata: {
                timezone: "America/New_York",
                pinned_agent_ids: ["agent-1", "agent-2"],
                send_mode: "cmd-enter",
                onboarding_done: true,
              },
            },
          ],
        },
      });

      await backfillOrgMembersMetadata(clerk, db(), stats, false);

      const row = await getOrgMembersEntry(orgId, userId);
      expect(row).toBeDefined();
      expect(row!.timezone).toBe("America/New_York");
      expect(row!.pinnedAgentIds).toEqual(["agent-1", "agent-2"]);
      expect(row!.sendMode).toBe("cmd-enter");
      expect(row!.onboardingDone).toBe(true);
      expect(stats.members.inserted).toBe(1);
    });

    it("does not overwrite existing member preferences", async () => {
      const orgId = uniqueId("bf-mem-keep");
      const userId = uniqueId("bf-mem-keep-u");
      trackMember(orgId, userId);

      await insertOrgMembersEntry({
        orgId,
        userId,
        timezone: "Asia/Tokyo",
        pinnedAgentIds: ["my-agent"],
        sendMode: "cmd-enter",
        onboardingDone: true,
      });

      const clerk = mockClerkClient({
        orgs: [{ id: orgId, publicMetadata: {} }],
        memberships: {
          [orgId]: [
            {
              publicUserData: { userId },
              publicMetadata: {
                timezone: "America/New_York",
              },
            },
          ],
        },
      });

      await backfillOrgMembersMetadata(clerk, db(), stats, false);

      const row = await getOrgMembersEntry(orgId, userId);
      // Original values preserved (onConflictDoNothing)
      expect(row!.timezone).toBe("Asia/Tokyo");
      expect(row!.pinnedAgentIds).toEqual(["my-agent"]);
    });

    it("skips members with empty Clerk metadata", async () => {
      const orgId = uniqueId("bf-mem-empty");
      const userId = uniqueId("bf-mem-empty-u");

      const clerk = mockClerkClient({
        orgs: [{ id: orgId, publicMetadata: {} }],
        memberships: {
          [orgId]: [{ publicUserData: { userId }, publicMetadata: {} }],
        },
      });

      await backfillOrgMembersMetadata(clerk, db(), stats, false);

      expect(stats.members.skipped).toBe(1);
      expect(stats.members.inserted).toBe(0);
    });

    it("skips members without publicUserData", async () => {
      const orgId = uniqueId("bf-mem-nouid");

      const clerk = mockClerkClient({
        orgs: [{ id: orgId, publicMetadata: {} }],
        memberships: {
          [orgId]: [
            { publicUserData: null, publicMetadata: { timezone: "UTC" } },
          ],
        },
      });

      await backfillOrgMembersMetadata(clerk, db(), stats, false);
      expect(stats.members.processed).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 3: users
  // -------------------------------------------------------------------------

  describe("backfillUsers", () => {
    it("inserts users with email_unsubscribed=true", async () => {
      const userId = uniqueId("bf-usr-unsub");
      trackUser(userId);

      const clerk = mockClerkClient({
        users: [{ id: userId, publicMetadata: { email_unsubscribed: true } }],
      });

      await backfillUsers(clerk, db(), stats, false);

      const row = await getUserRow(userId);
      expect(row).toBeDefined();
      expect(row!.emailUnsubscribed).toBe(true);
      expect(stats.users.upserted).toBe(1);
    });

    it("skips users with email_unsubscribed=false", async () => {
      const userId = uniqueId("bf-usr-sub");

      const clerk = mockClerkClient({
        users: [{ id: userId, publicMetadata: { email_unsubscribed: false } }],
      });

      await backfillUsers(clerk, db(), stats, false);

      const row = await getUserRow(userId);
      expect(row).toBeUndefined();
      expect(stats.users.skipped).toBe(1);
    });

    it("skips users with no metadata", async () => {
      const userId = uniqueId("bf-usr-nometa");

      const clerk = mockClerkClient({
        users: [{ id: userId, publicMetadata: {} }],
      });

      await backfillUsers(clerk, db(), stats, false);
      expect(stats.users.skipped).toBe(1);
    });

    it("preserves email_unsubscribed=true for existing users", async () => {
      const userId = uniqueId("bf-usr-exist");
      trackUser(userId);

      await insertUserRow(userId, true);

      const clerk = mockClerkClient({
        users: [{ id: userId, publicMetadata: { email_unsubscribed: true } }],
      });

      await backfillUsers(clerk, db(), stats, false);

      const row = await getUserRow(userId);
      expect(row!.emailUnsubscribed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting concerns
  // -------------------------------------------------------------------------

  describe("idempotency", () => {
    it("running backfill twice produces same result", async () => {
      const orgId = uniqueId("bf-idem-org");
      const userId = uniqueId("bf-idem-usr");
      trackOrg(orgId);
      trackMember(orgId, userId);
      trackUser(userId);

      const clerk = mockClerkClient({
        orgs: [{ id: orgId, publicMetadata: { tier: "pro" } }],
        memberships: {
          [orgId]: [
            {
              publicUserData: { userId },
              publicMetadata: { timezone: "UTC", onboarding_done: true },
            },
          ],
        },
        users: [{ id: userId, publicMetadata: { email_unsubscribed: true } }],
      });

      // First run
      await backfillOrgMetadata(clerk, db(), stats, false);
      await backfillOrgMembersMetadata(clerk, db(), stats, false);
      await backfillUsers(clerk, db(), stats, false);

      const orgRow1 = await getOrgRow(orgId);

      // Second run
      const stats2 = newStats();
      await backfillOrgMetadata(clerk, db(), stats2, false);
      await backfillOrgMembersMetadata(clerk, db(), stats2, false);
      await backfillUsers(clerk, db(), stats2, false);

      const orgRow2 = await getOrgRow(orgId);
      expect(orgRow2!.tier).toBe("pro");
      expect(orgRow2!.credits).toBe(orgRow1!.credits);
      expect(stats.errors).toHaveLength(0);
      expect(stats2.errors).toHaveLength(0);
    });
  });

  describe("error resilience", () => {
    it("continues processing after individual org failure", async () => {
      // No trackOrg for orgId1 — invalid UUID causes SQL error, nothing written to DB
      const orgId1 = uniqueId("bf-err-org1");
      const orgId2 = uniqueId("bf-err-org2");
      trackOrg(orgId2);

      const clerk = mockClerkClient({
        orgs: [
          {
            id: orgId1,
            publicMetadata: {
              tier: "pro",
              default_agent_compose_id: "not-a-valid-uuid",
            },
          },
          { id: orgId2, publicMetadata: { tier: "team" } },
        ],
      });

      await backfillOrgMetadata(clerk, db(), stats, false);

      // First org should have an error (invalid uuid for uuid column)
      expect(stats.errors.length).toBeGreaterThanOrEqual(1);
      expect(stats.errors[0]!.id).toBe(orgId1);

      // Second org should succeed
      const row2 = await getOrgRow(orgId2);
      expect(row2).toBeDefined();
      expect(row2!.tier).toBe("team");
    });

    it("aborts when error count exceeds threshold", async () => {
      // No trackOrg — all orgs have invalid UUIDs, every INSERT fails, nothing written to DB
      const badOrgs = Array.from({ length: MAX_ERRORS + 5 }, (_, i) => {
        return {
          id: uniqueId(`bf-thresh-${i}`),
          publicMetadata: {
            tier: "pro",
            default_agent_compose_id: "not-a-valid-uuid",
          },
        };
      });

      const clerk = mockClerkClient({ orgs: badOrgs });

      await expect(
        backfillOrgMetadata(clerk, db(), stats, false),
      ).rejects.toThrow("exceeded threshold");

      // Should have accumulated just over MAX_ERRORS before aborting
      expect(stats.errors.length).toBe(MAX_ERRORS + 1);
    });
  });
});
