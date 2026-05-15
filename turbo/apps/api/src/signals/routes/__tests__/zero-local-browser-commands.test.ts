import { createHash, randomUUID } from "node:crypto";

import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import {
  zeroLocalBrowserCommandApprovalContract,
  zeroLocalBrowserCommandContract,
  zeroLocalBrowserHostCommandsContract,
  zeroLocalBrowserWriteCommandContract,
} from "@vm0/api-contracts/contracts/zero-local-browser";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { connectors } from "@vm0/db/schema/connector";
import {
  localBrowserCommandAuditEvents,
  localBrowserCommands,
  localBrowserHosts,
} from "@vm0/db/schema/local-browser";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { eq, inArray } from "drizzle-orm";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now, nowDate } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mintZeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly ZeroCapability[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: args.capabilities,
    iat: seconds,
    exp: seconds + 3600,
  });
}

async function enableLocalBrowser(
  orgId: string,
  userId: string,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(userFeatureSwitches).values({
    orgId,
    userId,
    switches: { [FeatureSwitchKey.LocalBrowserUse]: true },
  });
}

async function seedLocalBrowserConnector(args: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  const now = nowDate();
  await writeDb.insert(connectors).values({
    orgId: args.orgId,
    userId: args.userId,
    type: "local-browser",
    authMethod: "api",
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    tokenExpiresAt: null,
    needsReconnect: false,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedLocalBrowserHost(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly hostToken: string;
  readonly supportedCapabilities: readonly string[];
}): Promise<string> {
  const writeDb = store.set(writeDb$);
  const now = nowDate();
  const [host] = await writeDb
    .insert(localBrowserHosts)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      displayName: "Desk Chrome",
      tokenHash: hashSecret(args.hostToken),
      browser: "chrome",
      extensionVersion: "0.1.0",
      supportedCapabilities: [...args.supportedCapabilities],
      status: "online",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: localBrowserHosts.id });

  if (!host) {
    throw new Error("Failed to seed local-browser host");
  }
  return host.id;
}

describe("local-browser read commands", () => {
  const fixtures: OrgMembershipFixture[] = [];
  const trackedOrgIds: string[] = [];

  async function createOrgFixture(): Promise<OrgMembershipFixture> {
    const fixture = await store.set(
      seedOrgMembership$,
      {
        orgId: `org_${randomUUID()}`,
        userId: `user_${randomUUID()}`,
      },
      context.signal,
    );
    fixtures.push(fixture);
    trackedOrgIds.push(fixture.orgId);
    await enableLocalBrowser(fixture.orgId, fixture.userId);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    return fixture;
  }

  afterEach(async () => {
    const writeDb = store.set(writeDb$);
    if (trackedOrgIds.length > 0) {
      await writeDb
        .delete(localBrowserCommandAuditEvents)
        .where(inArray(localBrowserCommandAuditEvents.orgId, trackedOrgIds));
      await writeDb
        .delete(localBrowserCommands)
        .where(inArray(localBrowserCommands.orgId, trackedOrgIds));
      await writeDb
        .delete(localBrowserHosts)
        .where(inArray(localBrowserHosts.orgId, trackedOrgIds));
      await writeDb
        .delete(connectors)
        .where(inArray(connectors.orgId, trackedOrgIds));
      await writeDb
        .delete(userFeatureSwitches)
        .where(inArray(userFeatureSwitches.orgId, trackedOrgIds));
      trackedOrgIds.length = 0;
    }
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("rejects zero tokens without local-browser read capability", async () => {
    const client = setupApp({ context })(zeroLocalBrowserCommandContract);
    const token = mintZeroToken({
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
      capabilities: ["connector:read"],
    });

    const response = await accept(
      client.create({
        body: { kind: "tabs.list", timeoutMs: 15_000 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "Missing required capability: local-browser:read",
    );
  });

  it("rejects zero tokens without local-browser write capability", async () => {
    const client = setupApp({ context })(zeroLocalBrowserWriteCommandContract);
    const token = mintZeroToken({
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
      capabilities: ["local-browser:read"],
    });

    const response = await accept(
      client.create({
        body: {
          kind: "page.click",
          selector: "button",
          timeoutMs: 15_000,
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "Missing required capability: local-browser:write",
    );
  });

  it("rejects write command URLs with non-http schemes", async () => {
    const fixture = await createOrgFixture();
    const client = setupApp({ context })(zeroLocalBrowserWriteCommandContract);
    const token = mintZeroToken({
      orgId: fixture.orgId,
      userId: fixture.userId,
      capabilities: ["local-browser:write"],
    });

    await accept(
      client.create({
        body: {
          kind: "page.navigate",
          url: "javascript:alert(1)",
          timeoutMs: 15_000,
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [400],
    );
  });

  it("returns no-host when the connector is connected without an online host", async () => {
    const fixture = await createOrgFixture();
    await seedLocalBrowserConnector(fixture);
    const token = mintZeroToken({
      orgId: fixture.orgId,
      userId: fixture.userId,
      capabilities: ["local-browser:read"],
    });
    const client = setupApp({ context })(zeroLocalBrowserCommandContract);

    const response = await accept(
      client.create({
        body: { kind: "tabs.list", timeoutMs: 15_000 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [404],
    );

    expect(response.body.error.message).toBe(
      "No linked local-browser host found",
    );
  });

  it("creates, claims, completes, and serializes a read-only command", async () => {
    const fixture = await createOrgFixture();
    await seedLocalBrowserConnector(fixture);
    const hostToken = `vm0_local_browser_host_${randomUUID()}`;
    const hostId = await seedLocalBrowserHost({
      ...fixture,
      hostToken,
      supportedCapabilities: ["tabs.list", "page.metadata"],
    });
    const token = mintZeroToken({
      orgId: fixture.orgId,
      userId: fixture.userId,
      capabilities: ["local-browser:read"],
    });
    const commandClient = setupApp({ context })(
      zeroLocalBrowserCommandContract,
    );

    const created = await accept(
      commandClient.create({
        body: { kind: "tabs.list", timeoutMs: 15_000 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(created.body.status).toBe("queued");

    const hostClient = setupApp({ context })(
      zeroLocalBrowserHostCommandsContract,
    );
    const claimed = await accept(
      hostClient.next({
        body: { supportedCapabilities: ["tabs.list"] },
        headers: { authorization: `Bearer ${hostToken}` },
      }),
      [200],
    );
    expect(claimed.body.status).toBe("command");
    if (claimed.body.status !== "command") {
      throw new Error("expected local-browser command");
    }
    expect(claimed.body.command).toMatchObject({
      id: created.body.commandId,
      kind: "tabs.list",
      payload: {},
      timeoutMs: 15_000,
    });

    await accept(
      hostClient.complete({
        params: { commandId: created.body.commandId },
        body: {
          status: "succeeded",
          result: {
            tabs: [
              {
                id: "tab-1",
                title: "Inbox",
                url: "https://example.com/inbox",
                faviconUrl: "https://example.com/favicon.ico",
                active: true,
              },
            ],
          },
        },
        headers: { authorization: `Bearer ${hostToken}` },
      }),
      [200],
    );

    const result = await accept(
      commandClient.get({
        params: { commandId: created.body.commandId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(result.body).toMatchObject({
      id: created.body.commandId,
      kind: "tabs.list",
      status: "succeeded",
      hostId,
      hostName: "Desk Chrome",
      result: {
        tabs: [
          {
            id: "tab-1",
            title: "Inbox",
            url: "https://example.com/inbox",
            faviconUrl: "https://example.com/favicon.ico",
            active: true,
          },
        ],
      },
    });

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        runId: localBrowserCommands.runId,
      })
      .from(localBrowserCommands)
      .where(eq(localBrowserCommands.id, created.body.commandId))
      .limit(1);
    expect(row?.runId).toMatch(/^run_/);
  });

  it("holds write commands for approval, then claims, completes, and audits them", async () => {
    const fixture = await createOrgFixture();
    await seedLocalBrowserConnector(fixture);
    const hostToken = `vm0_local_browser_host_${randomUUID()}`;
    await seedLocalBrowserHost({
      ...fixture,
      hostToken,
      supportedCapabilities: ["page.click"],
    });
    const token = mintZeroToken({
      orgId: fixture.orgId,
      userId: fixture.userId,
      capabilities: ["local-browser:write"],
    });
    const writeClient = setupApp({ context })(
      zeroLocalBrowserWriteCommandContract,
    );

    const created = await accept(
      writeClient.create({
        body: {
          kind: "page.click",
          selector: "button[data-action='save']",
          timeoutMs: 15_000,
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(created.body.status).toBe("pending_approval");

    const hostClient = setupApp({ context })(
      zeroLocalBrowserHostCommandsContract,
    );
    const beforeApproval = await accept(
      hostClient.next({
        body: { supportedCapabilities: ["page.click"] },
        headers: { authorization: `Bearer ${hostToken}` },
      }),
      [200],
    );
    expect(beforeApproval.body.status).toBe("idle");

    const approvalClient = setupApp({ context })(
      zeroLocalBrowserCommandApprovalContract,
    );
    const approved = await accept(
      approvalClient.decide({
        params: { commandId: created.body.commandId },
        body: { decision: "approve" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(approved.body).toStrictEqual({
      commandId: created.body.commandId,
      status: "queued",
    });

    const claimed = await accept(
      hostClient.next({
        body: { supportedCapabilities: ["page.click"] },
        headers: { authorization: `Bearer ${hostToken}` },
      }),
      [200],
    );
    expect(claimed.body.status).toBe("command");
    if (claimed.body.status !== "command") {
      throw new Error("expected local-browser command");
    }
    expect(claimed.body.command).toMatchObject({
      id: created.body.commandId,
      kind: "page.click",
      payload: { selector: "button[data-action='save']" },
      timeoutMs: 15_000,
    });

    await accept(
      hostClient.complete({
        params: { commandId: created.body.commandId },
        body: { status: "succeeded", result: { ok: true } },
        headers: { authorization: `Bearer ${hostToken}` },
      }),
      [200],
    );

    const commandClient = setupApp({ context })(
      zeroLocalBrowserCommandContract,
    );
    const result = await accept(
      commandClient.get({
        params: { commandId: created.body.commandId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(result.body).toMatchObject({
      id: created.body.commandId,
      kind: "page.click",
      status: "succeeded",
      result: { ok: true },
    });

    const writeDb = store.set(writeDb$);
    const auditRows = await writeDb
      .select({
        event: localBrowserCommandAuditEvents.event,
        approvalOutcome: localBrowserCommandAuditEvents.approvalOutcome,
        redactedResult: localBrowserCommandAuditEvents.redactedResult,
      })
      .from(localBrowserCommandAuditEvents)
      .where(
        eq(localBrowserCommandAuditEvents.commandId, created.body.commandId),
      );
    expect(
      auditRows.map((row) => {
        return row.event;
      }),
    ).toStrictEqual(
      expect.arrayContaining(["created", "approved", "completed"]),
    );
    expect(auditRows).toContainEqual(
      expect.objectContaining({
        event: "approved",
        approvalOutcome: "approved",
      }),
    );
    expect(auditRows).toContainEqual(
      expect.objectContaining({
        event: "completed",
        redactedResult: { ok: true },
      }),
    );
  });

  it("denies pending write commands with permission_denied and audits the denial", async () => {
    const fixture = await createOrgFixture();
    await seedLocalBrowserConnector(fixture);
    const hostToken = `vm0_local_browser_host_${randomUUID()}`;
    await seedLocalBrowserHost({
      ...fixture,
      hostToken,
      supportedCapabilities: ["page.navigate"],
    });
    const token = mintZeroToken({
      orgId: fixture.orgId,
      userId: fixture.userId,
      capabilities: ["local-browser:write"],
    });
    const writeClient = setupApp({ context })(
      zeroLocalBrowserWriteCommandContract,
    );
    const created = await accept(
      writeClient.create({
        body: {
          kind: "page.navigate",
          url: "https://example.com/checkout",
          timeoutMs: 15_000,
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    const approvalClient = setupApp({ context })(
      zeroLocalBrowserCommandApprovalContract,
    );
    const denied = await accept(
      approvalClient.decide({
        params: { commandId: created.body.commandId },
        body: { decision: "deny", message: "Not this tab" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(denied.body).toStrictEqual({
      commandId: created.body.commandId,
      status: "failed",
    });

    const hostClient = setupApp({ context })(
      zeroLocalBrowserHostCommandsContract,
    );
    const claimed = await accept(
      hostClient.next({
        body: { supportedCapabilities: ["page.navigate"] },
        headers: { authorization: `Bearer ${hostToken}` },
      }),
      [200],
    );
    expect(claimed.body.status).toBe("idle");

    const commandClient = setupApp({ context })(
      zeroLocalBrowserCommandContract,
    );
    const result = await accept(
      commandClient.get({
        params: { commandId: created.body.commandId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(result.body).toMatchObject({
      kind: "page.navigate",
      status: "failed",
      error: {
        code: "permission_denied",
        message: "Not this tab",
      },
    });

    const writeDb = store.set(writeDb$);
    const auditRows = await writeDb
      .select({
        event: localBrowserCommandAuditEvents.event,
        approvalOutcome: localBrowserCommandAuditEvents.approvalOutcome,
        error: localBrowserCommandAuditEvents.error,
      })
      .from(localBrowserCommandAuditEvents)
      .where(
        eq(localBrowserCommandAuditEvents.commandId, created.body.commandId),
      );
    expect(auditRows).toContainEqual(
      expect.objectContaining({
        event: "denied",
        approvalOutcome: "denied",
        error: {
          code: "permission_denied",
          message: "Not this tab",
        },
      }),
    );
  });

  it("serializes deterministic extension failures", async () => {
    const fixture = await createOrgFixture();
    await seedLocalBrowserConnector(fixture);
    const hostToken = `vm0_local_browser_host_${randomUUID()}`;
    await seedLocalBrowserHost({
      ...fixture,
      hostToken,
      supportedCapabilities: ["tabs.current"],
    });
    const token = mintZeroToken({
      orgId: fixture.orgId,
      userId: fixture.userId,
      capabilities: ["local-browser:read"],
    });
    const commandClient = setupApp({ context })(
      zeroLocalBrowserCommandContract,
    );
    const created = await accept(
      commandClient.create({
        body: { kind: "tabs.current", timeoutMs: 15_000 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    const hostClient = setupApp({ context })(
      zeroLocalBrowserHostCommandsContract,
    );
    await accept(
      hostClient.next({
        body: { supportedCapabilities: ["tabs.current"] },
        headers: { authorization: `Bearer ${hostToken}` },
      }),
      [200],
    );
    await accept(
      hostClient.complete({
        params: { commandId: created.body.commandId },
        body: {
          status: "failed",
          error: {
            code: "no_active_tab",
            message: "No active tab is available",
          },
        },
        headers: { authorization: `Bearer ${hostToken}` },
      }),
      [200],
    );

    const result = await accept(
      commandClient.get({
        params: { commandId: created.body.commandId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(result.body).toMatchObject({
      status: "failed",
      error: {
        code: "no_active_tab",
        message: "No active tab is available",
      },
    });
    expect(result.body).not.toHaveProperty("result");
  });
});
