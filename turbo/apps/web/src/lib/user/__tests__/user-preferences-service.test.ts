import { describe, it, expect, beforeEach, vi } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import { testContext } from "../../../__tests__/test-helpers";
import {
  insertOrgMembersEntry,
  findOrgMembersEntry,
} from "../../../__tests__/api-test-helpers";
import { getUserPreferences } from "../user-preferences-service";

const context = testContext();

describe("getUserPreferences", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns DB values when row exists, no Clerk call", async () => {
    const { userId, orgId } = await context.setupUser();
    await insertOrgMembersEntry({
      orgId,
      userId,
      timezone: "America/New_York",
      notifyEmail: true,
      notifySlack: false,
      pinnedAgentIds: ["agent-1"],
      sendMode: "cmd-enter",
    });

    const client = await clerkClient();
    const result = await getUserPreferences(orgId, userId);

    expect(result).toEqual({
      timezone: "America/New_York",
      notifyEmail: true,
      notifySlack: false,
      pinnedAgentIds: ["agent-1"],
      sendMode: "cmd-enter",
    });
    expect(
      client.organizations.getOrganizationMembershipList,
    ).not.toHaveBeenCalled();
  });

  it("falls back to Clerk metadata when no DB row, backfills DB", async () => {
    const { userId, orgId } = await context.setupUser();

    // Override Clerk membership list to return metadata
    const client = await clerkClient();
    vi.mocked(
      client.organizations.getOrganizationMembershipList,
    ).mockResolvedValueOnce({
      data: [
        {
          publicUserData: { userId },
          publicMetadata: {
            timezone: "Europe/London",
            notify_email: true,
            notify_slack: false,
            pinned_agent_ids: ["pinned-1", "pinned-2"],
            send_mode: "cmd-enter",
            onboarding_done: true,
          },
        },
      ],
    } as unknown as Awaited<
      ReturnType<typeof client.organizations.getOrganizationMembershipList>
    >);

    const result = await getUserPreferences(orgId, userId);

    expect(result).toEqual({
      timezone: "Europe/London",
      notifyEmail: true,
      notifySlack: false,
      pinnedAgentIds: ["pinned-1", "pinned-2"],
      sendMode: "cmd-enter",
    });

    // Verify backfill happened (fire-and-forget, wait a tick)
    await new Promise((r) => setTimeout(r, 50));
    const row = await findOrgMembersEntry(orgId, userId);

    expect(row).toBeDefined();
    expect(row!.timezone).toBe("Europe/London");
    expect(row!.notifyEmail).toBe(true);
    expect(row!.notifySlack).toBe(false);
    expect(row!.onboardingDone).toBe(true);
    expect(row!.sendMode).toBe("cmd-enter");
  });

  it("returns DEFAULTS when no DB row and Clerk has empty metadata", async () => {
    const { userId, orgId } = await context.setupUser();

    // Default Clerk mock returns empty publicMetadata
    const result = await getUserPreferences(orgId, userId);

    expect(result).toEqual({
      timezone: null,
      notifyEmail: false,
      notifySlack: true,
      pinnedAgentIds: [],
      sendMode: "enter",
    });
  });

  it("backfills onboardingDone from Clerk metadata", async () => {
    const { userId, orgId } = await context.setupUser();

    const client = await clerkClient();
    vi.mocked(
      client.organizations.getOrganizationMembershipList,
    ).mockResolvedValueOnce({
      data: [
        {
          publicUserData: { userId },
          publicMetadata: {
            onboarding_done: true,
          },
        },
      ],
    } as unknown as Awaited<
      ReturnType<typeof client.organizations.getOrganizationMembershipList>
    >);

    await getUserPreferences(orgId, userId);

    // Wait for fire-and-forget backfill
    await new Promise((r) => setTimeout(r, 50));
    const row = await findOrgMembersEntry(orgId, userId);

    expect(row).toBeDefined();
    expect(row!.onboardingDone).toBe(true);
  });
});
