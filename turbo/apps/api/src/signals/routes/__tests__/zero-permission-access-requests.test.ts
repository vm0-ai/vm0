import { randomUUID } from "node:crypto";

import { command, createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { RawPermissionPolicies } from "@vm0/connectors/firewall-types";
import {
  permissionAccessRequestsListContract,
  permissionAccessRequestsResolveContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { permissionAccessRequests } from "@vm0/db/schema/permission-access-request";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

type OrgRole = "admin" | "member";
type AgentVisibility = "public" | "private";

interface PermissionAccessOrgFixture {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly agentId: string;
}

interface SeedPermissionAccessOrgValues {
  readonly ownerUserId?: string;
  readonly ownerRole?: OrgRole;
  readonly visibility?: AgentVisibility;
  readonly permissionPolicies?: RawPermissionPolicies;
}

interface SeedOrgMemberValues {
  readonly orgId: string;
  readonly userId: string;
  readonly role: OrgRole;
}

interface SeedAccessRequestValues {
  readonly orgId: string;
  readonly agentId: string;
  readonly requesterUserId: string;
  readonly connectorRef?: string;
  readonly permission?: string;
  readonly action?: "allow" | "deny";
  readonly status?: string;
  readonly reason?: string;
  readonly method?: string;
  readonly path?: string;
}

interface AccessRequestFixture {
  readonly id: string;
}

const seedPermissionAccessOrg$ = command(
  async (
    { set },
    values: SeedPermissionAccessOrgValues,
    signal: AbortSignal,
  ): Promise<PermissionAccessOrgFixture> => {
    const writeDb = set(writeDb$);
    const orgId = `org_${randomUUID()}`;
    const ownerUserId = values.ownerUserId ?? `user_${randomUUID()}`;
    const agentId = randomUUID();
    const agentName = `agent-${agentId.slice(0, 8)}`;

    await writeDb.insert(orgCache).values({
      orgId,
      slug: `org-${orgId.slice(-8)}`,
      name: "",
    });
    signal.throwIfAborted();

    await writeDb.insert(orgMembersCache).values({
      orgId,
      userId: ownerUserId,
      role: values.ownerRole ?? "admin",
    });
    signal.throwIfAborted();

    await writeDb.insert(agentComposes).values({
      id: agentId,
      userId: ownerUserId,
      orgId,
      name: agentName,
    });
    signal.throwIfAborted();

    await writeDb.insert(zeroAgents).values({
      id: agentId,
      orgId,
      owner: ownerUserId,
      name: agentName,
      visibility: values.visibility ?? "public",
      permissionPolicies: values.permissionPolicies,
    });
    signal.throwIfAborted();

    return { orgId, ownerUserId, agentId };
  },
);

const seedOrgMember$ = command(
  async ({ set }, values: SeedOrgMemberValues, signal: AbortSignal) => {
    const writeDb = set(writeDb$);
    await writeDb.insert(orgMembersCache).values(values);
    signal.throwIfAborted();
  },
);

const seedAccessRequest$ = command(
  async (
    { set },
    values: SeedAccessRequestValues,
    signal: AbortSignal,
  ): Promise<AccessRequestFixture> => {
    const writeDb = set(writeDb$);
    const [row] = await writeDb
      .insert(permissionAccessRequests)
      .values({
        orgId: values.orgId,
        agentId: values.agentId,
        requesterUserId: values.requesterUserId,
        connectorRef: values.connectorRef ?? "github",
        permission: values.permission ?? "issues:read",
        action: values.action,
        status: values.status ?? "pending",
        reason: values.reason,
        method: values.method,
        path: values.path,
      })
      .returning({ id: permissionAccessRequests.id });
    signal.throwIfAborted();

    if (!row) {
      throw new Error("Failed to seed permission access request");
    }
    return row;
  },
);

const deletePermissionAccessOrg$ = command(
  async (
    { set },
    fixture: PermissionAccessOrgFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(permissionAccessRequests)
      .where(eq(permissionAccessRequests.orgId, fixture.orgId));
    signal.throwIfAborted();

    await writeDb.delete(zeroAgents).where(eq(zeroAgents.orgId, fixture.orgId));
    signal.throwIfAborted();

    await writeDb
      .delete(agentComposes)
      .where(eq(agentComposes.orgId, fixture.orgId));
    signal.throwIfAborted();

    await writeDb
      .delete(orgMembersCache)
      .where(eq(orgMembersCache.orgId, fixture.orgId));
    signal.throwIfAborted();

    await writeDb.delete(orgCache).where(eq(orgCache.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);

function apiClient() {
  return setupApp({ context })(permissionAccessRequestsListContract);
}

function resolveApiClient() {
  return setupApp({ context })(permissionAccessRequestsResolveContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

async function readAgentPolicies(
  agentId: string,
): Promise<RawPermissionPolicies | null | undefined> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ permissionPolicies: zeroAgents.permissionPolicies })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, agentId))
    .limit(1);
  return row?.permissionPolicies;
}

function mockClerkUsers(
  users: readonly {
    readonly id: string;
    readonly firstName: string | null;
    readonly lastName: string | null;
  }[],
): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: users.map((user) => {
      return {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
      };
    }),
  });
}

beforeEach(() => {
  mockClerkUsers([]);
});

describe("GET /api/zero/permission-access-requests", () => {
  const track = createFixtureTracker<PermissionAccessOrgFixture>((fixture) => {
    return store.set(deletePermissionAccessOrg$, fixture, context.signal);
  });

  it("lists access requests for an agent", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    await store.set(
      seedAccessRequest$,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
        requesterUserId: fixture.ownerUserId,
        connectorRef: "github",
        permission: "issues:read",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const response = await accept(
      apiClient().list({
        headers: authHeaders(),
        query: { agentId: fixture.agentId },
      }),
      [200],
    );

    expect(response.body).toHaveLength(1);
    expect(response.body[0]?.agentId).toBe(fixture.agentId);
    expect(response.body[0]?.connectorRef).toBe("github");
    expect(response.body[0]?.permission).toBe("issues:read");
    expect(response.body[0]?.status).toBe("pending");
  });

  it("filters access requests by status", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    await store.set(
      seedAccessRequest$,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
        requesterUserId: fixture.ownerUserId,
        connectorRef: "github",
        status: "pending",
      },
      context.signal,
    );
    await store.set(
      seedAccessRequest$,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
        requesterUserId: fixture.ownerUserId,
        connectorRef: "slack",
        permission: "channels:read",
        status: "approved",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const response = await accept(
      apiClient().list({
        headers: authHeaders(),
        query: { agentId: fixture.agentId, status: "approved" },
      }),
      [200],
    );

    expect(response.body).toHaveLength(1);
    expect(response.body[0]?.connectorRef).toBe("slack");
    expect(response.body[0]?.status).toBe("approved");
  });

  it("fetches a single access request by requestId", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    const request = await store.set(
      seedAccessRequest$,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
        requesterUserId: fixture.ownerUserId,
        reason: "Need access",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const response = await accept(
      apiClient().list({
        headers: authHeaders(),
        query: { requestId: request.id },
      }),
      [200],
    );

    expect(response.body).toHaveLength(1);
    expect(response.body[0]?.id).toBe(request.id);
    expect(response.body[0]?.reason).toBe("Need access");
  });

  it("returns an empty array for a nonexistent requestId", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const response = await accept(
      apiClient().list({
        headers: authHeaders(),
        query: { requestId: randomUUID() },
      }),
      [200],
    );

    expect(response.body).toStrictEqual([]);
  });

  it("returns 400 when agentId and requestId are missing", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const response = await accept(
      apiClient().list({
        headers: authHeaders(),
        query: {},
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Either agentId or requestId is required",
        code: "VALIDATION_ERROR",
      },
    });
  });

  it("restricts non-owner members to their own requests while owners and admins see all", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    const memberUserId = `user_${randomUUID()}`;
    const adminUserId = `user_${randomUUID()}`;
    await store.set(
      seedOrgMember$,
      { orgId: fixture.orgId, userId: memberUserId, role: "member" },
      context.signal,
    );
    await store.set(
      seedOrgMember$,
      { orgId: fixture.orgId, userId: adminUserId, role: "admin" },
      context.signal,
    );
    await store.set(
      seedAccessRequest$,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
        requesterUserId: fixture.ownerUserId,
        connectorRef: "github",
      },
      context.signal,
    );
    await store.set(
      seedAccessRequest$,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
        requesterUserId: memberUserId,
        connectorRef: "slack",
        permission: "channels:read",
      },
      context.signal,
    );

    mocks.clerk.session(memberUserId, fixture.orgId, "org:member");
    const memberResponse = await accept(
      apiClient().list({
        headers: authHeaders(),
        query: { agentId: fixture.agentId },
      }),
      [200],
    );
    expect(memberResponse.body).toHaveLength(1);
    expect(memberResponse.body[0]?.connectorRef).toBe("slack");

    mocks.clerk.session(fixture.ownerUserId, fixture.orgId, "org:admin");
    const ownerResponse = await accept(
      apiClient().list({
        headers: authHeaders(),
        query: { agentId: fixture.agentId },
      }),
      [200],
    );
    expect(ownerResponse.body).toHaveLength(2);

    mocks.clerk.session(adminUserId, fixture.orgId, "org:admin");
    const adminResponse = await accept(
      apiClient().list({
        headers: authHeaders(),
        query: { agentId: fixture.agentId },
      }),
      [200],
    );
    expect(adminResponse.body).toHaveLength(2);
  });

  it("includes requesterName from Clerk user data", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    await store.set(
      seedAccessRequest$,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
        requesterUserId: fixture.ownerUserId,
      },
      context.signal,
    );
    mockClerkUsers([
      { id: fixture.ownerUserId, firstName: "Alice", lastName: "Smith" },
    ]);
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const response = await accept(
      apiClient().list({
        headers: authHeaders(),
        query: { agentId: fixture.agentId },
      }),
      [200],
    );

    expect(response.body).toHaveLength(1);
    expect(response.body[0]?.requesterName).toBe("Alice Smith");
  });

  it("returns null requesterName when Clerk has no name data", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    await store.set(
      seedAccessRequest$,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
        requesterUserId: fixture.ownerUserId,
      },
      context.signal,
    );
    mockClerkUsers([
      { id: fixture.ownerUserId, firstName: null, lastName: null },
    ]);
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const response = await accept(
      apiClient().list({
        headers: authHeaders(),
        query: { agentId: fixture.agentId },
      }),
      [200],
    );

    expect(response.body).toHaveLength(1);
    expect(response.body[0]?.requesterName).toBeNull();
  });

  it("returns 401 without auth", async () => {
    const response = await accept(
      apiClient().list({
        headers: {},
        query: { agentId: randomUUID() },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

describe("PUT /api/zero/permission-access-requests", () => {
  const track = createFixtureTracker<PermissionAccessOrgFixture>((fixture) => {
    return store.set(deletePermissionAccessOrg$, fixture, context.signal);
  });

  it("approves a request and updates permission policies", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    const request = await store.set(
      seedAccessRequest$,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
        requesterUserId: fixture.ownerUserId,
        connectorRef: "github",
        permission: "issues:read",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const response = await accept(
      resolveApiClient().resolve({
        headers: authHeaders(),
        body: { requestId: request.id, action: "approve" },
      }),
      [200],
    );

    expect(response.body.status).toBe("approved");
    expect(response.body.resolvedBy).toBe(fixture.ownerUserId);
    expect(response.body.resolvedAt).toStrictEqual(expect.any(String));
    await expect(readAgentPolicies(fixture.agentId)).resolves.toStrictEqual({
      github: { "issues:read": "allow" },
    });
  });

  it("approves a deny request and stores a deny policy", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    const request = await store.set(
      seedAccessRequest$,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
        requesterUserId: fixture.ownerUserId,
        connectorRef: "github",
        permission: "issues:read",
        action: "deny",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const response = await accept(
      resolveApiClient().resolve({
        headers: authHeaders(),
        body: { requestId: request.id, action: "approve" },
      }),
      [200],
    );

    expect(response.body.status).toBe("approved");
    await expect(readAgentPolicies(fixture.agentId)).resolves.toStrictEqual({
      github: { "issues:read": "deny" },
    });
  });

  it("rejects a request without updating permission policies", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    const request = await store.set(
      seedAccessRequest$,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
        requesterUserId: fixture.ownerUserId,
        connectorRef: "github",
        permission: "issues:read",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const response = await accept(
      resolveApiClient().resolve({
        headers: authHeaders(),
        body: { requestId: request.id, action: "reject" },
      }),
      [200],
    );

    expect(response.body.status).toBe("rejected");
    await expect(readAgentPolicies(fixture.agentId)).resolves.toBeNull();
  });

  it("allows an org admin to resolve another user's agent requests", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    const adminUserId = `user_${randomUUID()}`;
    await store.set(
      seedOrgMember$,
      { orgId: fixture.orgId, userId: adminUserId, role: "admin" },
      context.signal,
    );
    const request = await store.set(
      seedAccessRequest$,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
        requesterUserId: fixture.ownerUserId,
      },
      context.signal,
    );
    mocks.clerk.session(adminUserId, fixture.orgId, "org:admin");

    const response = await accept(
      resolveApiClient().resolve({
        headers: authHeaders(),
        body: { requestId: request.id, action: "approve" },
      }),
      [200],
    );

    expect(response.body.status).toBe("approved");
    expect(response.body.resolvedBy).toBe(adminUserId);
  });

  it("returns 403 for org admins resolving private agent requests they do not own", async () => {
    const fixture = await track(
      store.set(
        seedPermissionAccessOrg$,
        { visibility: "private" },
        context.signal,
      ),
    );
    const adminUserId = `user_${randomUUID()}`;
    await store.set(
      seedOrgMember$,
      { orgId: fixture.orgId, userId: adminUserId, role: "admin" },
      context.signal,
    );
    const request = await store.set(
      seedAccessRequest$,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
        requesterUserId: fixture.ownerUserId,
      },
      context.signal,
    );
    mocks.clerk.session(adminUserId, fixture.orgId, "org:admin");

    const response = await accept(
      resolveApiClient().resolve({
        headers: authHeaders(),
        body: { requestId: request.id, action: "approve" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Only the private agent owner can resolve permission access requests",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 403 for non-owner members resolving requests", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    const memberUserId = `user_${randomUUID()}`;
    await store.set(
      seedOrgMember$,
      { orgId: fixture.orgId, userId: memberUserId, role: "member" },
      context.signal,
    );
    const request = await store.set(
      seedAccessRequest$,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
        requesterUserId: fixture.ownerUserId,
      },
      context.signal,
    );
    mocks.clerk.session(memberUserId, fixture.orgId, "org:member");

    const response = await accept(
      resolveApiClient().resolve({
        headers: authHeaders(),
        body: { requestId: request.id, action: "approve" },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 404 for nonexistent requests", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const requestId = randomUUID();
    const response = await accept(
      resolveApiClient().resolve({
        headers: authHeaders(),
        body: { requestId, action: "approve" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: `Access request not found: ${requestId}`,
        code: "NOT_FOUND",
      },
    });
  });

  it("returns 400 for already resolved requests", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    const request = await store.set(
      seedAccessRequest$,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
        requesterUserId: fixture.ownerUserId,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    await accept(
      resolveApiClient().resolve({
        headers: authHeaders(),
        body: { requestId: request.id, action: "approve" },
      }),
      [200],
    );
    const response = await accept(
      resolveApiClient().resolve({
        headers: authHeaders(),
        body: { requestId: request.id, action: "reject" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Request already resolved with status: approved",
        code: "ALREADY_RESOLVED",
      },
    });
  });

  it("preserves existing permission policies when approving", async () => {
    const fixture = await track(
      store.set(
        seedPermissionAccessOrg$,
        {
          permissionPolicies: {
            slack: { "channels:read": "allow" },
          },
        },
        context.signal,
      ),
    );
    const request = await store.set(
      seedAccessRequest$,
      {
        orgId: fixture.orgId,
        agentId: fixture.agentId,
        requesterUserId: fixture.ownerUserId,
        connectorRef: "github",
        permission: "issues:read",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    await accept(
      resolveApiClient().resolve({
        headers: authHeaders(),
        body: { requestId: request.id, action: "approve" },
      }),
      [200],
    );

    await expect(readAgentPolicies(fixture.agentId)).resolves.toStrictEqual({
      slack: { "channels:read": "allow" },
      github: { "issues:read": "allow" },
    });
  });

  it("returns 401 without auth", async () => {
    const response = await accept(
      resolveApiClient().resolve({
        headers: {},
        body: { requestId: randomUUID(), action: "approve" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});
