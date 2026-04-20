import { describe, it, expect, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import {
  mockAblyPublish,
  mockAblyChannelsGet,
} from "../../../__tests__/ably-mock";
import { insertOrgMembersCacheEntry } from "../../../__tests__/db-test-seeders/org-members-cache";
import { publishOrgAdminSignal, publishOrgSignal } from "../realtime";

const context = testContext();

describe("publishOrgAdminSignal", () => {
  beforeEach(() => {
    context.setupMocks();
    mockAblyPublish.mockClear();
    mockAblyChannelsGet.mockClear();
  });

  it("publishes signal only to admin members, not regular members", async () => {
    await context.setupUser();

    const orgId = uniqueId("org");
    const adminUserId = uniqueId("admin-user");
    const memberUserId = uniqueId("member-user");

    await insertOrgMembersCacheEntry({
      orgId,
      userId: adminUserId,
      role: "admin",
    });
    await insertOrgMembersCacheEntry({
      orgId,
      userId: memberUserId,
      role: "member",
    });

    await publishOrgAdminSignal(orgId, "slack:changed");

    // Published exactly once — for the admin only, not the regular member
    expect(mockAblyChannelsGet).toHaveBeenCalledTimes(1);
    expect(mockAblyChannelsGet).toHaveBeenCalledWith(`user:${adminUserId}`);
    expect(mockAblyChannelsGet).not.toHaveBeenCalledWith(
      `user:${memberUserId}`,
    );
    expect(mockAblyPublish).toHaveBeenCalledTimes(1);
    expect(mockAblyPublish).toHaveBeenCalledWith("slack:changed", null);
  });

  it("does not publish when org has no admin members", async () => {
    await context.setupUser();

    const orgId = uniqueId("org");
    const memberUserId = uniqueId("member-user");

    await insertOrgMembersCacheEntry({
      orgId,
      userId: memberUserId,
      role: "member",
    });

    await publishOrgAdminSignal(orgId, "slack:changed");

    expect(mockAblyPublish).not.toHaveBeenCalled();
  });

  it("does not publish when org has no members at all", async () => {
    await context.setupUser();

    const orgId = uniqueId("empty-org");

    await publishOrgAdminSignal(orgId, "slack:changed");

    expect(mockAblyPublish).not.toHaveBeenCalled();
  });
});

describe("publishOrgSignal", () => {
  beforeEach(() => {
    context.setupMocks();
    mockAblyPublish.mockClear();
    mockAblyChannelsGet.mockClear();
  });

  it("publishes signal to all org members", async () => {
    await context.setupUser();

    const orgId = uniqueId("org");
    const adminUserId = uniqueId("admin-user");
    const memberUserId = uniqueId("member-user");

    await insertOrgMembersCacheEntry({
      orgId,
      userId: adminUserId,
      role: "admin",
    });
    await insertOrgMembersCacheEntry({
      orgId,
      userId: memberUserId,
      role: "member",
    });

    await publishOrgSignal(orgId, "queue:changed");

    // Published to both admin and regular member
    expect(mockAblyChannelsGet).toHaveBeenCalledTimes(2);
    expect(mockAblyChannelsGet).toHaveBeenCalledWith(`user:${adminUserId}`);
    expect(mockAblyChannelsGet).toHaveBeenCalledWith(`user:${memberUserId}`);
    expect(mockAblyPublish).toHaveBeenCalledTimes(2);
    expect(mockAblyPublish).toHaveBeenCalledWith("queue:changed", null);
  });

  it("does not publish when org has no members", async () => {
    await context.setupUser();

    const orgId = uniqueId("empty-org");

    await publishOrgSignal(orgId, "queue:changed");

    expect(mockAblyPublish).not.toHaveBeenCalled();
  });
});
