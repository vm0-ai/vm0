import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { zeroIntegrationsSlackContract } from "@vm0/api-contracts/contracts/zero-integrations-slack";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { http, HttpResponse } from "msw";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgCache } from "@vm0/db/schema/org-cache";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { and, eq } from "drizzle-orm";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { now } from "../../external/time";
import { writeDb$ } from "../../external/db";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { ROUTES } from "../../route";
import { SlackFileFetchError } from "../../external/slack-file-fetcher";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteSlackIntegrationFixture$,
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
  type SlackIntegrationFixture,
} from "./helpers/zero-integrations-slack";

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
    tier: "free",
    credits: 10_000,
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
    // Admin + connected: scope fields should be present (botScopes null → mismatch)
    expect(response.body).toHaveProperty("scopeMismatch");
    expect(response.body).toHaveProperty("reinstallUrl");
    // Connected: install/connect URLs should NOT be present
    expect(response.body).not.toHaveProperty("installUrl");
    expect(response.body).not.toHaveProperty("connectUrl");
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

    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isAdmin).toBeFalsy();
    // Non-admin + connected: scope fields should NOT be present
    expect(response.body).not.toHaveProperty("scopeMismatch");
    expect(response.body).not.toHaveProperty("reinstallUrl");
    // Connected: install/connect URLs should NOT be present
    expect(response.body).not.toHaveProperty("installUrl");
    expect(response.body).not.toHaveProperty("connectUrl");
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
    // Not connected: install/connect URLs should be present
    expect(response.body).toHaveProperty("installUrl");
    expect(response.body).toHaveProperty("connectUrl");
    // Admin + installed: scope fields should be present (botScopes null → mismatch)
    expect(response.body).toHaveProperty("scopeMismatch");
    expect(response.body).toHaveProperty("reinstallUrl");
    // Not connected: workspace/environment fields should NOT be present
    expect(response.body).not.toHaveProperty("workspaceName");
    expect(response.body).not.toHaveProperty("defaultAgentName");
    expect(response.body).not.toHaveProperty("agentOrgSlug");
    expect(response.body).not.toHaveProperty("environment");
  });

  describe("environment field", () => {
    afterEach(async () => {
      await writeDb.delete(variables).where(eq(variables.orgId, fixture.orgId));
      await writeDb.delete(secrets).where(eq(secrets.orgId, fixture.orgId));
    });

    const dol = "\x24";
    const composeContent = JSON.parse(
      `{"settings":{"api_key":"${dol}{{ secrets.SEC_A }}","region":"${dol}{{ vars.VAR_A }}"}}`,
    ) as Record<string, unknown>;

    async function seedEnvironmentVersion(): Promise<void> {
      const versionId = randomUUID();
      await writeDb.insert(agentComposeVersions).values({
        id: versionId,
        composeId: fixture.composeId,
        content: composeContent,
        createdBy: fixture.userId,
      });
      await writeDb
        .update(agentComposes)
        .set({ headVersionId: versionId })
        .where(eq(agentComposes.id, fixture.composeId));
    }

    async function seedUserSecret(name: string): Promise<void> {
      await writeDb.insert(secrets).values({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name,
        encryptedValue: `encrypted_${name}`,
        type: "user",
      });
    }

    async function seedUserVariable(
      name: string,
      value: string,
    ): Promise<void> {
      await writeDb.insert(variables).values({
        orgId: fixture.orgId,
        userId: fixture.userId,
        name,
        value,
      });
    }

    function mockAdminAuth(): void {
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
    }

    it("includes environment when connected with head version and secrets/vars present", async () => {
      await seedEnvironmentVersion();
      await seedUserSecret("SEC_A");
      await seedUserVariable("VAR_A", "us-east-1");

      mockAdminAuth();

      const client = setupApp({ context })(zeroIntegrationsSlackContract);

      const response = await accept(
        client.getStatus({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(response.body.environment).toBeDefined();
      expect(response.body.environment!.requiredSecrets).toStrictEqual([
        "SEC_A",
      ]);
      expect(response.body.environment!.requiredVars).toStrictEqual(["VAR_A"]);
      expect(response.body.environment!.missingSecrets).toStrictEqual([]);
      expect(response.body.environment!.missingVars).toStrictEqual([]);
    });

    it("reports missing secrets and vars in environment", async () => {
      await seedEnvironmentVersion();

      mockAdminAuth();

      const client = setupApp({ context })(zeroIntegrationsSlackContract);

      const response = await accept(
        client.getStatus({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(response.body.environment).toBeDefined();
      expect(response.body.environment!.requiredSecrets).toStrictEqual([
        "SEC_A",
      ]);
      expect(response.body.environment!.requiredVars).toStrictEqual(["VAR_A"]);
      expect(response.body.environment!.missingSecrets).toStrictEqual([
        "SEC_A",
      ]);
      expect(response.body.environment!.missingVars).toStrictEqual(["VAR_A"]);
    });

    it("omits environment when isConnected is false", async () => {
      await writeDb
        .delete(slackOrgConnections)
        .where(eq(slackOrgConnections.slackWorkspaceId, fixture.workspaceId));

      await seedEnvironmentVersion();
      await seedUserSecret("SEC_A");
      await seedUserVariable("VAR_A", "us-east-1");

      mockAdminAuth();

      const client = setupApp({ context })(zeroIntegrationsSlackContract);

      const response = await accept(
        client.getStatus({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(response.body.isConnected).toBeFalsy();
      expect(response.body.environment).toBeUndefined();
    });
  });
});

async function findSlackConnection(args: {
  readonly workspaceId: string;
  readonly userId: string;
}): Promise<typeof slackOrgConnections.$inferSelect | undefined> {
  const [connection] = await writeDb
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackWorkspaceId, args.workspaceId),
        eq(slackOrgConnections.vm0UserId, args.userId),
      ),
    )
    .limit(1);
  return connection;
}

async function findSlackInstallation(
  workspaceId: string,
): Promise<typeof slackOrgInstallations.$inferSelect | undefined> {
  const [installation] = await writeDb
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);
  return installation;
}

function listWorkspaceSlackConnections(
  workspaceId: string,
): Promise<readonly (typeof slackOrgConnections.$inferSelect)[]> {
  return writeDb
    .select()
    .from(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, workspaceId));
}

describe("DELETE /api/zero/integrations/slack", () => {
  const trackSlackFixture = createFixtureTracker<SlackIntegrationFixture>(
    (fixture) => {
      return store.set(deleteSlackIntegrationFixture$, fixture, context.signal);
    },
  );
  const mocks = createZeroRouteMocks(context);

  beforeEach(() => {
    context.mocks.slack.views.publish.mockResolvedValue({ ok: true });
  });

  async function seedDeleteContext(
    args: {
      readonly userId?: string;
      readonly orgId?: string;
      readonly withConnection?: boolean;
    } = {},
  ): Promise<{
    readonly orgId: string;
    readonly userId: string;
    readonly workspaceId: string;
    readonly slackUserId: string | null;
  }> {
    const orgId = args.orgId ?? `org_${randomUUID()}`;
    const userId = args.userId ?? `user_${randomUUID()}`;
    const fixture = await trackSlackFixture(
      store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
    );
    const connection =
      args.withConnection === false
        ? null
        : await store.set(
            seedSlackOrgConnection$,
            {
              slackWorkspaceId: fixture.slackWorkspaceId,
              vm0UserId: userId,
            },
            context.signal,
          );

    return {
      orgId,
      userId,
      workspaceId: fixture.slackWorkspaceId,
      slackUserId: connection?.slackUserId ?? null,
    };
  }

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.disconnect({ headers: {}, query: {} }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 when the user has no Slack connection", async () => {
    const seeded = await seedDeleteContext({ withConnection: false });
    mocks.clerk.session(seeded.userId, seeded.orgId);
    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: {},
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.body.error.message).toBe("No Slack connection found");
  });

  it("deletes only the current user's connection and refreshes App Home", async () => {
    const seeded = await seedDeleteContext();
    const otherUserId = `user_${randomUUID()}`;
    const otherConnection = await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: seeded.workspaceId,
        vm0UserId: otherUserId,
      },
      context.signal,
    );
    mocks.clerk.session(seeded.userId, seeded.orgId);
    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: {},
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ ok: true });
    await expect(
      findSlackConnection({
        workspaceId: seeded.workspaceId,
        userId: seeded.userId,
      }),
    ).resolves.toBeUndefined();
    await expect(
      findSlackConnection({
        workspaceId: seeded.workspaceId,
        userId: otherUserId,
      }),
    ).resolves.toMatchObject({ slackUserId: otherConnection.slackUserId });
    expect(context.mocks.slack.views.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: seeded.slackUserId,
        view: expect.objectContaining({
          type: "home",
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: "actions",
              elements: expect.arrayContaining([
                expect.objectContaining({ action_id: "home_login_prompt" }),
              ]),
            }),
          ]),
        }),
      }),
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "slack:changed",
      null,
    );
  });
});

describe("DELETE /api/zero/integrations/slack?action=uninstall", () => {
  const trackSlackFixture = createFixtureTracker<SlackIntegrationFixture>(
    (fixture) => {
      return store.set(deleteSlackIntegrationFixture$, fixture, context.signal);
    },
  );
  const trackOrgMembership = createFixtureTracker<OrgMembershipFixture>(
    (fixture) => {
      return store.set(deleteOrgMembership$, fixture, context.signal);
    },
  );
  const mocks = createZeroRouteMocks(context);

  beforeEach(() => {
    context.mocks.slack.views.publish.mockResolvedValue({ ok: true });
  });

  async function seedUninstallContext(
    args: {
      readonly orgId?: string;
      readonly userId?: string;
      readonly withInstallation?: boolean;
    } = {},
  ): Promise<{
    readonly orgId: string;
    readonly userId: string;
    readonly workspaceId: string | null;
    readonly slackUserIds: readonly string[];
  }> {
    const orgId = args.orgId ?? `org_${randomUUID()}`;
    const userId = args.userId ?? `user_${randomUUID()}`;
    if (args.withInstallation === false) {
      return { orgId, userId, workspaceId: null, slackUserIds: [] };
    }

    const fixture = await trackSlackFixture(
      store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
    );
    const firstConnection = await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: fixture.slackWorkspaceId,
        vm0UserId: userId,
      },
      context.signal,
    );
    const secondConnection = await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: fixture.slackWorkspaceId,
        vm0UserId: `user_${randomUUID()}`,
      },
      context.signal,
    );

    return {
      orgId,
      userId,
      workspaceId: fixture.slackWorkspaceId,
      slackUserIds: [firstConnection.slackUserId, secondConnection.slackUserId],
    };
  }

  it("returns 403 when a non-admin tries to uninstall", async () => {
    const seeded = await seedUninstallContext();
    mocks.clerk.session(seeded.userId, seeded.orgId, "org:member");
    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: { action: "uninstall" },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toBe("Admin access required");
  });

  it("returns 404 when no installation exists", async () => {
    const seeded = await seedUninstallContext({ withInstallation: false });
    mocks.clerk.session(seeded.userId, seeded.orgId, "org:admin");
    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: { action: "uninstall" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.body.error.message).toBe("No Slack installation found");
  });

  it("publishes uninstalled App Home then deletes installation and connections", async () => {
    const seeded = await seedUninstallContext();
    await trackOrgMembership(
      store.set(
        seedOrgMembership$,
        {
          orgId: seeded.orgId,
          userId: seeded.userId,
          role: "admin",
          seedOrgCache: false,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(seeded.userId, seeded.orgId, "org:admin");
    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: { action: "uninstall" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ ok: true });
    expect(context.mocks.slack.views.publish).toHaveBeenCalledTimes(2);
    for (const slackUserId of seeded.slackUserIds) {
      expect(context.mocks.slack.views.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: slackUserId,
          view: expect.objectContaining({
            type: "home",
            blocks: expect.arrayContaining([
              expect.objectContaining({
                type: "actions",
                elements: expect.arrayContaining([
                  expect.objectContaining({ action_id: "home_open_settings" }),
                ]),
              }),
            ]),
          }),
        }),
      );
    }
    const workspaceId = seeded.workspaceId;
    expect(workspaceId).not.toBeNull();
    if (workspaceId === null) {
      throw new Error("workspaceId should be present for uninstall test");
    }
    await expect(findSlackInstallation(workspaceId)).resolves.toBeUndefined();
    await expect(
      listWorkspaceSlackConnections(workspaceId),
    ).resolves.toStrictEqual([]);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "slack:changed",
      null,
    );
  });
});

type SlackFileMetadata = {
  readonly id: string;
  readonly name: string;
  readonly mimetype: string;
  readonly size: number;
  readonly url_private_download?: string;
  readonly url_private?: string;
};

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly ("slack:write" | "file:read")[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: args.capabilities,
    iat: seconds,
    exp: seconds + 60,
  });
}

function mockSlackFilesInfo(
  response:
    | { readonly ok: true; readonly file: SlackFileMetadata }
    | { readonly ok: false; readonly error: string },
): void {
  server.use(
    http.get("https://slack.com/api/files.info", () => {
      return HttpResponse.json(response);
    }),
  );
}

function defaultSlackFile(
  overrides: Partial<SlackFileMetadata> = {},
): SlackFileMetadata {
  return {
    id: "F-OK",
    name: "pic.png",
    mimetype: "image/png",
    size: 19,
    url_private_download:
      "https://files.slack.com/files-pri/T1-F-OK/download/pic.png",
    ...overrides,
  };
}

function requestDownloadFile(
  query: string,
  authorization?: string,
): Promise<Response> {
  const app = createApp({ signal: context.signal, routes: ROUTES });
  const headers: Record<string, string> = authorization
    ? { authorization }
    : {};
  return Promise.resolve(
    app.request(`/api/zero/integrations/slack/download-file${query}`, {
      method: "GET",
      headers,
    }),
  );
}

async function expectErrorResponse(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as {
    readonly error?: { readonly code?: string };
  };
  expect(body.error?.code).toBe(code);
}

describe("GET /api/zero/integrations/slack/download-file", () => {
  const trackSlackFixture = createFixtureTracker<SlackIntegrationFixture>(
    (fixture) => {
      return store.set(deleteSlackIntegrationFixture$, fixture, context.signal);
    },
  );
  const trackMembership = createFixtureTracker<OrgMembershipFixture>(
    (fixture) => {
      return store.set(deleteOrgMembership$, fixture, context.signal);
    },
  );
  const mocks = createZeroRouteMocks(context);

  async function seedDownloadContext(
    args: {
      readonly withInstallation?: boolean;
    } = {},
  ): Promise<{ readonly token: string }> {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await trackMembership(
      store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );

    if (args.withInstallation !== false) {
      await trackSlackFixture(
        store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
      );
    }

    return {
      token: zeroToken({ userId, orgId, capabilities: ["slack:write"] }),
    };
  }

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await requestDownloadFile("?file_id=F1");

    await expectErrorResponse(response, 401, "UNAUTHORIZED");
  });

  it("rejects a zero token without slack:write capability", async () => {
    const token = zeroToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      capabilities: ["file:read"],
    });

    const response = await requestDownloadFile(
      "?file_id=F1",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 403, "FORBIDDEN");
  });

  it("returns 400 when file_id query param is missing", async () => {
    const { token } = await seedDownloadContext();

    const response = await requestDownloadFile("", `Bearer ${token}`);

    await expectErrorResponse(response, 400, "BAD_REQUEST");
  });

  it("returns 404 when no Slack installation exists for org", async () => {
    const { token } = await seedDownloadContext({ withInstallation: false });

    const response = await requestDownloadFile(
      "?file_id=F1",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 404, "NOT_FOUND");
  });

  it("returns 404 when Slack reports file not found", async () => {
    const { token } = await seedDownloadContext();
    mockSlackFilesInfo({ ok: false, error: "file_not_found" });

    const response = await requestDownloadFile(
      "?file_id=F-MISSING",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 404, "NOT_FOUND");
  });

  it("returns 404 when the Slack file has no downloadable URL", async () => {
    const { token } = await seedDownloadContext();
    const file = defaultSlackFile();
    mockSlackFilesInfo({
      ok: true,
      file: {
        id: file.id,
        name: file.name,
        mimetype: file.mimetype,
        size: file.size,
      },
    });

    const response = await requestDownloadFile(
      "?file_id=F1",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 404, "NOT_FOUND");
  });

  it("returns 400 for disallowed download hostnames", async () => {
    const { token } = await seedDownloadContext();
    mockSlackFilesInfo({
      ok: true,
      file: defaultSlackFile({
        url_private_download: "https://evil.example.com/steal.png",
      }),
    });
    context.mocks.slack.fetchFile.mockRejectedValue(
      new SlackFileFetchError("invalid-url", "Invalid Slack download URL"),
    );

    const response = await requestDownloadFile(
      "?file_id=F-BAD",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 400, "BAD_REQUEST");
  });

  it("returns 413 when file metadata exceeds the 100MB limit", async () => {
    const { token } = await seedDownloadContext();
    mockSlackFilesInfo({
      ok: true,
      file: defaultSlackFile({ size: 200 * 1024 * 1024 }),
    });

    const response = await requestDownloadFile(
      "?file_id=F-BIG",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 413, "PAYLOAD_TOO_LARGE");
  });

  it("returns 502 when Slack file download fails", async () => {
    const { token } = await seedDownloadContext();
    mockSlackFilesInfo({ ok: true, file: defaultSlackFile() });
    context.mocks.slack.fetchFile.mockRejectedValue(
      new SlackFileFetchError(
        "download-failed",
        "Failed to download Slack file",
        503,
      ),
    );

    const response = await requestDownloadFile(
      "?file_id=F1",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 502, "BAD_GATEWAY");
  });

  it("returns 502 when Slack returns an HTML response", async () => {
    const { token } = await seedDownloadContext();
    mockSlackFilesInfo({ ok: true, file: defaultSlackFile() });
    context.mocks.slack.fetchFile.mockResolvedValue(
      new Response("<html><body>Login</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const response = await requestDownloadFile(
      "?file_id=F1",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 502, "BAD_GATEWAY");
  });

  it("returns 400 when Slack files.info returns a platform error", async () => {
    const { token } = await seedDownloadContext();
    mockSlackFilesInfo({ ok: false, error: "invalid_auth" });

    const response = await requestDownloadFile(
      "?file_id=F1",
      `Bearer ${token}`,
    );

    await expectErrorResponse(response, 400, "SLACK_ERROR");
  });

  it("streams file bytes from Slack with file metadata headers", async () => {
    const { token } = await seedDownloadContext();
    const fileBytes = Buffer.from("real file contents");
    mockSlackFilesInfo({ ok: true, file: defaultSlackFile() });
    context.mocks.slack.fetchFile.mockResolvedValue(
      new Response(fileBytes, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(fileBytes.length),
        },
      }),
    );

    const response = await requestDownloadFile(
      "?file_id=F-OK",
      `Bearer ${token}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-file-mimetype")).toBe("image/png");
    expect(response.headers.get("x-file-name")).toBe("pic.png");
    expect(response.headers.get("content-length")).toBe(
      String(fileBytes.length),
    );
    const receivedBytes = Buffer.from(await response.arrayBuffer());
    expect(receivedBytes.equals(fileBytes)).toBeTruthy();
  });

  it("accepts a Clerk session with an active organization", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await trackSlackFixture(
      store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
    );
    mocks.clerk.session(userId, orgId);
    mockSlackFilesInfo({ ok: true, file: defaultSlackFile() });
    context.mocks.slack.fetchFile.mockResolvedValue(
      new Response(Buffer.from("ok"), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const response = await requestDownloadFile(
      "?file_id=F-OK",
      "Bearer clerk-session",
    );

    expect(response.status).toBe(200);
  });
});
