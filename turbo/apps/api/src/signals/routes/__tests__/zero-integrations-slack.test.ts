import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { zeroIntegrationsSlackContract } from "@vm0/api-contracts/contracts/zero-integrations-slack";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgCache } from "@vm0/db/schema/org-cache";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockApiShadowCompareRoutes } from "../../context/shadow-compare";
import { writeDb$ } from "../../external/db";

const context = testContext();
const store = createStore();
const writeDb = store.set(writeDb$);

interface SlackFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly composeId: string;
  readonly workspaceId: string;
}

async function seedSlackFixture(
  _overrides: { orgRole?: "admin" | "member" } = {},
): Promise<SlackFixture> {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const composeId = randomUUID();
  const workspaceId = `T_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

  await writeDb.insert(agentComposes).values({
    id: composeId,
    userId,
    orgId,
    name: `slack-agent`,
  });

  await writeDb.insert(zeroAgents).values({
    id: composeId,
    orgId,
    owner: userId,
    displayName: "Slack Bot",
    name: "slack-bot",
  });

  await writeDb.insert(orgMetadata).values({
    orgId,
    defaultAgentId: composeId,
  });

  await writeDb.insert(orgCache).values({
    orgId,
    slug: "test-org-slug",
    name: "Test Org",
  });

  await writeDb.insert(slackOrgInstallations).values({
    slackWorkspaceId: workspaceId,
    slackWorkspaceName: "Test Workspace",
    orgId,
    encryptedBotToken: "encrypted-token",
    botUserId: "U_BOT123",
  });

  await writeDb.insert(slackOrgConnections).values({
    slackUserId: "U_USER123",
    slackWorkspaceId: workspaceId,
    vm0UserId: userId,
  });

  return { userId, orgId, composeId, workspaceId };
}

async function cleanupSlackFixture(fixture: SlackFixture): Promise<void> {
  await writeDb
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, fixture.workspaceId));
  await writeDb
    .delete(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, fixture.workspaceId));
  await writeDb.delete(orgCache).where(eq(orgCache.orgId, fixture.orgId));
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await writeDb.delete(zeroAgents).where(eq(zeroAgents.id, fixture.composeId));
  await writeDb
    .delete(agentComposes)
    .where(eq(agentComposes.id, fixture.composeId));
}

describe("GET /api/zero/integrations/slack", () => {
  let fixture: SlackFixture;

  beforeEach(async () => {
    fixture = await seedSlackFixture();
  });

  afterEach(async () => {
    await cleanupSlackFixture(fixture);
  });

  it("returns isAdmin: true for admin users", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => {
        return {
          userId: fixture.userId,
          orgId: fixture.orgId,
          orgRole: "org:admin",
        };
      },
    });
    mockApiShadowCompareRoutes([zeroIntegrationsSlackContract.getStatus]);

    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isAdmin).toBeTruthy();
    expect(response.body.isConnected).toBeTruthy();
    expect(response.body.isInstalled).toBeTruthy();
    expect(response.body.workspaceName).toBe("Test Workspace");
    expect(response.body.defaultAgentName).toBe("Slack Bot");
    expect(response.body.agentOrgSlug).toBe("test-org-slug");
  });

  it("returns isAdmin: false for non-admin users", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => {
        return {
          userId: fixture.userId,
          orgId: fixture.orgId,
          orgRole: "org:member",
        };
      },
    });
    mockApiShadowCompareRoutes([zeroIntegrationsSlackContract.getStatus]);

    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isAdmin).toBeFalsy();
  });

  it("returns isConnected: false when user has no connection", async () => {
    await writeDb
      .delete(slackOrgConnections)
      .where(eq(slackOrgConnections.slackWorkspaceId, fixture.workspaceId));

    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => {
        return {
          userId: fixture.userId,
          orgId: fixture.orgId,
          orgRole: "org:admin",
        };
      },
    });
    mockApiShadowCompareRoutes([zeroIntegrationsSlackContract.getStatus]);

    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isConnected).toBeFalsy();
    expect(response.body.isInstalled).toBeTruthy();
    expect(response.body.isAdmin).toBeTruthy();
  });
});
