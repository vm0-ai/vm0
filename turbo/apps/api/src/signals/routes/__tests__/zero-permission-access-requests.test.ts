import { randomUUID } from "node:crypto";

import { command, createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { RawPermissionPolicies } from "@vm0/connectors/firewall-types";
import {
  permissionAccessRequestsCreateContract,
  permissionAccessRequestsListContract,
  permissionAccessRequestsResolveContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { permissionAccessRequests } from "@vm0/db/schema/permission-access-request";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearAllDetached } from "../../utils";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { encryptSecretForTests } from "./helpers/encrypt-secret";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

type OrgRole = "admin" | "member";
type AgentVisibility = "public" | "private";

interface PermissionAccessOrgFixture {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly agentId: string;
  readonly slackWorkspaceId?: string;
}

interface SeedPermissionAccessOrgValues {
  readonly ownerUserId?: string;
  readonly ownerRole?: OrgRole;
  readonly visibility?: AgentVisibility;
  readonly permissionPolicies?: RawPermissionPolicies;
  readonly ownerSlackUserId?: string;
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

    const ownerSlackUserId = values.ownerSlackUserId;
    const slackWorkspaceId = ownerSlackUserId
      ? `T_${randomUUID().replaceAll("-", "").slice(0, 12)}`
      : undefined;
    if (ownerSlackUserId && slackWorkspaceId) {
      await writeDb.insert(slackOrgInstallations).values({
        slackWorkspaceId,
        slackWorkspaceName: "Test Workspace",
        orgId,
        encryptedBotToken: encryptSecretForTests("xoxb-permission-test"),
        botUserId: "U_BOT_PERMISSION",
      });
      signal.throwIfAborted();

      await writeDb.insert(slackOrgConnections).values({
        slackUserId: ownerSlackUserId,
        slackWorkspaceId,
        vm0UserId: ownerUserId,
      });
      signal.throwIfAborted();
    }

    return { orgId, ownerUserId, agentId, slackWorkspaceId };
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
    if (fixture.slackWorkspaceId) {
      await writeDb
        .delete(slackOrgConnections)
        .where(
          eq(slackOrgConnections.slackWorkspaceId, fixture.slackWorkspaceId),
        );
      signal.throwIfAborted();

      await writeDb
        .delete(slackOrgInstallations)
        .where(
          eq(slackOrgInstallations.slackWorkspaceId, fixture.slackWorkspaceId),
        );
      signal.throwIfAborted();
    }

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

function createApiClient() {
  return setupApp({ context })(permissionAccessRequestsCreateContract);
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

describe("POST /api/zero/permission-access-requests", () => {
  const track = createFixtureTracker<PermissionAccessOrgFixture>((fixture) => {
    return store.set(deletePermissionAccessOrg$, fixture, context.signal);
  });

  it("creates a permission access request", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const response = await accept(
      createApiClient().create({
        headers: authHeaders(),
        body: {
          agentId: fixture.agentId,
          connectorRef: "github",
          permission: "issues:read",
          reason: "Need to read issues",
        },
      }),
      [201],
    );

    expect(response.body).toMatchObject({
      agentId: fixture.agentId,
      connectorRef: "github",
      permission: "issues:read",
      action: "allow",
      reason: "Need to read issues",
      status: "pending",
      requesterUserId: fixture.ownerUserId,
      requesterName: null,
      resolvedBy: null,
      resolvedAt: null,
    });
    expect(response.body.id).toStrictEqual(expect.any(String));
    expect(response.body.createdAt).toStrictEqual(expect.any(String));
  });

  it("deduplicates pending requests by updating the reason", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const first = await accept(
      createApiClient().create({
        headers: authHeaders(),
        body: {
          agentId: fixture.agentId,
          connectorRef: "github",
          permission: "issues:read",
          reason: "First reason",
        },
      }),
      [201],
    );
    const second = await accept(
      createApiClient().create({
        headers: authHeaders(),
        body: {
          agentId: fixture.agentId,
          connectorRef: "github",
          permission: "issues:read",
          reason: "Updated reason",
        },
      }),
      [201],
    );

    expect(second.body.id).toBe(first.body.id);
    expect(second.body.reason).toBe("Updated reason");
  });

  it("creates a request with an explicit action", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const response = await accept(
      createApiClient().create({
        headers: authHeaders(),
        body: {
          agentId: fixture.agentId,
          connectorRef: "github",
          permission: "issues:read",
          action: "deny",
          reason: "Should not read issues",
        },
      }),
      [201],
    );

    expect(response.body.action).toBe("deny");
    expect(response.body.permission).toBe("issues:read");
  });

  it("treats different actions as separate requests for deduplication", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const allow = await accept(
      createApiClient().create({
        headers: authHeaders(),
        body: {
          agentId: fixture.agentId,
          connectorRef: "github",
          permission: "issues:read",
          action: "allow",
        },
      }),
      [201],
    );
    const deny = await accept(
      createApiClient().create({
        headers: authHeaders(),
        body: {
          agentId: fixture.agentId,
          connectorRef: "github",
          permission: "issues:read",
          action: "deny",
        },
      }),
      [201],
    );

    expect(deny.body.id).not.toBe(allow.body.id);
    expect(allow.body.action).toBe("allow");
    expect(deny.body.action).toBe("deny");
  });

  it("reuses a rejected request and resets it to pending", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const created = await accept(
      createApiClient().create({
        headers: authHeaders(),
        body: {
          agentId: fixture.agentId,
          connectorRef: "github",
          permission: "issues:read",
          reason: "First try",
        },
      }),
      [201],
    );
    await accept(
      resolveApiClient().resolve({
        headers: authHeaders(),
        body: { requestId: created.body.id, action: "reject" },
      }),
      [200],
    );

    const resent = await accept(
      createApiClient().create({
        headers: authHeaders(),
        body: {
          agentId: fixture.agentId,
          connectorRef: "github",
          permission: "issues:read",
          reason: "Second try",
        },
      }),
      [201],
    );

    expect(resent.body.id).toBe(created.body.id);
    expect(resent.body.status).toBe("pending");
    expect(resent.body.reason).toBe("Second try");
    expect(resent.body.resolvedBy).toBeNull();
    expect(resent.body.resolvedAt).toBeNull();
  });

  it("returns 400 for an unknown connector ref", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const response = await accept(
      createApiClient().create({
        headers: authHeaders(),
        body: {
          agentId: fixture.agentId,
          connectorRef: "nonexistent-connector",
          permission: "read",
        },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Unknown connector ref: nonexistent-connector",
        code: "VALIDATION_ERROR",
      },
    });
  });

  it("returns 404 for a nonexistent agent", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);
    const agentId = randomUUID();

    const response = await accept(
      createApiClient().create({
        headers: authHeaders(),
        body: {
          agentId,
          connectorRef: "github",
          permission: "issues:read",
        },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: `Agent not found: ${agentId}`,
        code: "NOT_FOUND",
      },
    });
  });

  it("returns 401 without auth", async () => {
    const response = await accept(
      createApiClient().create({
        headers: {},
        body: {
          agentId: randomUUID(),
          connectorRef: "github",
          permission: "issues:read",
        },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("allows non-admin members to create requests", async () => {
    const fixture = await track(
      store.set(seedPermissionAccessOrg$, {}, context.signal),
    );
    const memberUserId = `user_${randomUUID()}`;
    await store.set(
      seedOrgMember$,
      { orgId: fixture.orgId, userId: memberUserId, role: "member" },
      context.signal,
    );
    mocks.clerk.session(memberUserId, fixture.orgId, "org:member");

    const response = await accept(
      createApiClient().create({
        headers: authHeaders(),
        body: {
          agentId: fixture.agentId,
          connectorRef: "github",
          permission: "issues:read",
        },
      }),
      [201],
    );

    expect(response.body.requesterUserId).toBe(memberUserId);
  });

  it("notifies the agent owner through Slack when creating a request", async () => {
    const fixture = await track(
      store.set(
        seedPermissionAccessOrg$,
        { ownerSlackUserId: "U_OWNER_PERMISSION" },
        context.signal,
      ),
    );
    context.mocks.slack.chat.postMessage.mockResolvedValue({
      ok: true,
      ts: "1700000000.000100",
      channel: "U_OWNER_PERMISSION",
    });
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const response = await accept(
      createApiClient().create({
        headers: authHeaders(),
        body: {
          agentId: fixture.agentId,
          connectorRef: "github",
          permission: "issues:read",
          reason: "Need issue context",
        },
      }),
      [201],
    );
    await clearAllDetached();

    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "U_OWNER_PERMISSION",
        text: expect.stringContaining(
          'requesting to allow "issues:read" on GitHub',
        ),
      }),
    );
    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          `/agents/${fixture.agentId}/permissions?request=${response.body.id}`,
        ),
      }),
    );
  });
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

  it("notifies the requester through Slack when resolving a request", async () => {
    const fixture = await track(
      store.set(
        seedPermissionAccessOrg$,
        { ownerSlackUserId: "U_REQUESTER_PERMISSION" },
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
    context.mocks.slack.chat.postMessage.mockResolvedValue({
      ok: true,
      ts: "1700000000.000200",
      channel: "U_REQUESTER_PERMISSION",
    });
    mocks.clerk.session(fixture.ownerUserId, fixture.orgId);

    const response = await accept(
      resolveApiClient().resolve({
        headers: authHeaders(),
        body: { requestId: request.id, action: "approve" },
      }),
      [200],
    );
    await clearAllDetached();

    expect(response.body.status).toBe("approved");
    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "U_REQUESTER_PERMISSION",
        text: expect.stringContaining(
          'Your request to allow "issues:read" on GitHub',
        ),
      }),
    );
    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("has been approved"),
      }),
    );
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
