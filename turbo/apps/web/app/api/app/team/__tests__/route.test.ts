import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { GET } from "../route";
import { createTestCompose } from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();

describe("GET /api/app/team", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    // Team endpoint reads orgId from Clerk session, so configure it
    mockClerk({ userId: user.userId, orgId: user.orgId });
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 403 when no active org", async () => {
    mockClerk({ userId: user.userId, orgId: null });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error.code).toBe("FORBIDDEN");
  });

  it("should return empty list when org has no composes", async () => {
    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.composes).toEqual([]);
  });

  it("should return composes for the active org", async () => {
    const composeName = `team-test-${randomUUID().slice(0, 8)}`;
    await createTestCompose(composeName);

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.composes).toHaveLength(1);
    expect(data.composes[0].name).toBe(composeName);
    expect(data.composes[0].id).toBeDefined();
    expect(data.composes[0].updatedAt).toBeDefined();
  });

  it("should not return composes from other orgs", async () => {
    // Create compose for current user's org
    const myComposeName = `my-agent-${randomUUID().slice(0, 8)}`;
    await createTestCompose(myComposeName);

    // Create another user with a different org
    const otherUser = await context.setupUser({ prefix: "other-user" });
    mockClerk({ userId: otherUser.userId, orgId: otherUser.orgId });
    const otherComposeName = `other-agent-${randomUUID().slice(0, 8)}`;
    await createTestCompose(otherComposeName);

    // Switch back to original user
    mockClerk({ userId: user.userId, orgId: user.orgId });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    const names = data.composes.map((c: { name: string }) => c.name);
    expect(names).toContain(myComposeName);
    expect(names).not.toContain(otherComposeName);
  });
});
