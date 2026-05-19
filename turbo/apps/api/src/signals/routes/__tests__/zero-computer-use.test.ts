import { createHash, randomUUID } from "node:crypto";

import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import {
  zeroComputerUseCommandApprovalContract,
  zeroComputerUseCommandContract,
  zeroComputerUseHostCommandsContract,
  zeroComputerUseHostsContract,
  zeroComputerUseWriteCommandContract,
} from "@vm0/api-contracts/contracts/zero-computer-use";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  computerUseCommandAuditEvents,
  computerUseCommands,
  computerUseHosts,
} from "@vm0/db/schema/computer-use-host";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
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

const supportedCapabilities = [
  "apps.list",
  "app.state",
  "app.open",
  "element.click",
  "element.scroll",
  "element.set_value",
  "element.perform_action",
  "keyboard.type_text",
  "keyboard.press_key",
] as const;

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

async function enableComputerUse(orgId: string, userId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(userFeatureSwitches).values({
    orgId,
    userId,
    switches: { [FeatureSwitchKey.ComputerUse]: true },
  });
}

async function seedComputerUseHost(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly hostToken: string;
}): Promise<string> {
  const writeDb = store.set(writeDb$);
  const [host] = await writeDb
    .insert(computerUseHosts)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      displayName: "Zero Desktop",
      tokenHash: hashSecret(args.hostToken),
      appVersion: "0.1.0",
      osVersion: "macOS 15",
      supportedCapabilities: [...supportedCapabilities],
      permissions: { accessibility: true, screenRecording: true },
    })
    .returning({ id: computerUseHosts.id });

  if (!host) {
    throw new Error("Failed to seed computer-use host");
  }
  return host.id;
}

describe("desktop computer-use runtime", () => {
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
    await enableComputerUse(fixture.orgId, fixture.userId);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    return fixture;
  }

  afterEach(async () => {
    const writeDb = store.set(writeDb$);
    if (trackedOrgIds.length > 0) {
      await writeDb
        .delete(computerUseCommandAuditEvents)
        .where(inArray(computerUseCommandAuditEvents.orgId, trackedOrgIds));
      await writeDb
        .delete(computerUseCommands)
        .where(inArray(computerUseCommands.orgId, trackedOrgIds));
      await writeDb
        .delete(computerUseHosts)
        .where(inArray(computerUseHosts.orgId, trackedOrgIds));
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

  it("gates command creation on computer-use write capability", async () => {
    const fixture = await createOrgFixture();
    await seedComputerUseHost({
      orgId: fixture.orgId,
      userId: fixture.userId,
      hostToken: "host-token",
    });
    const client = setupApp({ context })(zeroComputerUseCommandContract);
    const token = mintZeroToken({
      orgId: fixture.orgId,
      userId: fixture.userId,
      capabilities: ["connector:read"],
    });

    const response = await accept(
      client.create({
        body: { kind: "apps.list", timeoutMs: 15_000 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "Missing required capability: computer-use:write",
    );
  });

  it("starts and lists a Desktop app computer-use host", async () => {
    const fixture = await createOrgFixture();
    const client = setupApp({ context })(zeroComputerUseHostsContract);

    const started = await accept(
      client.start({
        body: {
          hostName: "Zero Desktop",
          appVersion: "0.1.0",
          osVersion: "macOS 15",
          supportedCapabilities: [...supportedCapabilities],
          permissions: { accessibility: true, screenRecording: false },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(started.body.hostToken).toMatch(/^vm0_computer_use_host_/);

    const listed = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(listed.body.hosts).toHaveLength(1);
    expect(listed.body.hosts[0]).toMatchObject({
      id: started.body.hostId,
      displayName: "Zero Desktop",
      status: "online",
      permissions: { accessibility: true, screenRecording: false },
    });
    expect(fixture.orgId).toBeTruthy();
  });

  it("runs a read command through the host claim and complete flow", async () => {
    const fixture = await createOrgFixture();
    const hostToken = "host-token";
    const hostId = await seedComputerUseHost({
      orgId: fixture.orgId,
      userId: fixture.userId,
      hostToken,
    });
    const commandClient = setupApp({ context })(zeroComputerUseCommandContract);
    const hostClient = setupApp({ context })(
      zeroComputerUseHostCommandsContract,
    );
    const token = mintZeroToken({
      orgId: fixture.orgId,
      userId: fixture.userId,
      capabilities: ["computer-use:write"],
    });

    const created = await accept(
      commandClient.create({
        body: { kind: "app.state", app: "Safari", timeoutMs: 15_000 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    const next = await accept(
      hostClient.next({
        body: { supportedCapabilities: [...supportedCapabilities] },
        headers: { authorization: `Bearer ${hostToken}` },
      }),
      [200],
    );

    expect(next.body.status).toBe("command");
    if (next.body.status !== "command") {
      throw new Error("expected command");
    }
    expect(next.body.command).toMatchObject({
      id: created.body.commandId,
      hostId,
      kind: "app.state",
      status: "running",
      payload: { app: "Safari" },
    });

    await accept(
      hostClient.complete({
        params: { commandId: created.body.commandId },
        body: {
          status: "succeeded",
          result: {
            text: "snapshot_id=snap_1\n1 button Open",
            snapshotId: "snap_1",
          },
        },
        headers: { authorization: `Bearer ${hostToken}` },
      }),
      [200],
    );

    const completed = await accept(
      commandClient.get({
        params: { commandId: created.body.commandId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(completed.body).toMatchObject({
      status: "succeeded",
      result: { snapshotId: "snap_1" },
    });
  });

  it("requires approval for write commands and audits the decision", async () => {
    const fixture = await createOrgFixture();
    await seedComputerUseHost({
      orgId: fixture.orgId,
      userId: fixture.userId,
      hostToken: "host-token",
    });
    const writeClient = setupApp({ context })(
      zeroComputerUseWriteCommandContract,
    );
    const approvalClient = setupApp({ context })(
      zeroComputerUseCommandApprovalContract,
    );
    const token = mintZeroToken({
      orgId: fixture.orgId,
      userId: fixture.userId,
      capabilities: ["computer-use:write"],
    });

    const created = await accept(
      writeClient.create({
        body: {
          kind: "element.click",
          app: "Safari",
          elementId: "42",
          timeoutMs: 15_000,
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(created.body.status).toBe("pending_approval");

    const agentApproval = await accept(
      approvalClient.decide({
        params: { commandId: created.body.commandId },
        body: { decision: "approve" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );
    expect(agentApproval.body.error.message).toBe(
      "This endpoint is not available for sandbox tokens",
    );

    const approved = await accept(
      approvalClient.decide({
        params: { commandId: created.body.commandId },
        body: { decision: "approve" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(approved.body.status).toBe("queued");

    const writeDb = store.set(writeDb$);
    const auditEvents = await writeDb
      .select()
      .from(computerUseCommandAuditEvents)
      .where(inArray(computerUseCommandAuditEvents.orgId, [fixture.orgId]));
    expect(
      auditEvents
        .map((event) => {
          return event.event;
        })
        .sort(),
    ).toStrictEqual(["approved", "created"]);
  });
});
