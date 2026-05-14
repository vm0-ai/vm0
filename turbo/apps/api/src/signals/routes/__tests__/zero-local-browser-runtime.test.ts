import { createHash, randomUUID } from "node:crypto";

import {
  zeroLocalBrowserDeviceClaimContract,
  zeroLocalBrowserDevicePollContract,
  zeroLocalBrowserDeviceStartContract,
  zeroLocalBrowserHeartbeatContract,
  zeroLocalBrowserHostRealtimeContract,
  zeroLocalBrowserHostsContract,
  zeroLocalBrowserHostSelfContract,
} from "@vm0/api-contracts/contracts/zero-local-browser";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  localBrowserDeviceCodes,
  localBrowserHosts,
} from "@vm0/db/schema/local-browser";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { inArray } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
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

const tokenRequest = Object.freeze({
  keyName: "test-key",
  timestamp: 1_700_000_000_000,
  capability: "{}",
  nonce: "test-nonce",
  mac: "test-mac",
});

const runtimeBody = Object.freeze({
  hostName: "Desk Chrome",
  browser: "chrome",
  extensionVersion: "0.1.0",
  supportedCapabilities: ["tabs.list"],
});

function normalizeDeviceCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, "");
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

describe("local-browser runtime", () => {
  const seededFixtures: OrgMembershipFixture[] = [];
  const trackedDeviceCodeHashes: string[] = [];
  const trackedOrgIds: string[] = [];

  async function createOrgFixture(): Promise<OrgMembershipFixture> {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const fixture = await store.set(
      seedOrgMembership$,
      { orgId, userId },
      context.signal,
    );
    seededFixtures.push(fixture);
    trackedOrgIds.push(orgId);
    await enableLocalBrowser(orgId, userId);
    mocks.clerk.session(userId, orgId);
    return fixture;
  }

  function trackDeviceCode(deviceCode: string): void {
    trackedDeviceCodeHashes.push(hashSecret(normalizeDeviceCode(deviceCode)));
  }

  async function cleanupRuntimeFixtures(): Promise<void> {
    const writeDb = store.set(writeDb$);
    if (trackedDeviceCodeHashes.length > 0) {
      await writeDb
        .delete(localBrowserDeviceCodes)
        .where(
          inArray(localBrowserDeviceCodes.codeHash, trackedDeviceCodeHashes),
        );
      trackedDeviceCodeHashes.length = 0;
    }
    if (trackedOrgIds.length > 0) {
      await writeDb
        .delete(localBrowserDeviceCodes)
        .where(inArray(localBrowserDeviceCodes.orgId, trackedOrgIds));
      await writeDb
        .delete(localBrowserHosts)
        .where(inArray(localBrowserHosts.orgId, trackedOrgIds));
      await writeDb
        .delete(userFeatureSwitches)
        .where(inArray(userFeatureSwitches.orgId, trackedOrgIds));
      trackedOrgIds.length = 0;
    }
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  }

  beforeEach(() => {
    context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);
  });

  afterEach(async () => {
    await cleanupRuntimeFixtures();
  });

  it("pairs an extension, heartbeats, mints realtime, and lists the host", async () => {
    const startClient = setupApp({ context })(
      zeroLocalBrowserDeviceStartContract,
    );
    const startResponse = await accept(
      startClient.start({ body: runtimeBody }),
      [200],
    );
    trackDeviceCode(startResponse.body.deviceCode);

    expect(startResponse.body.verificationPath).toBe(
      "/zero/connectors/local-browser",
    );
    expect(startResponse.body.pollToken).toMatch(/^vm0_local_browser_poll_/);
    expect(startResponse.body.realtime?.eventName).toBe("approved");
    expect(startResponse.body.realtime?.channelName).toMatch(
      /^local-browser-device:/,
    );

    const pollClient = setupApp({ context })(
      zeroLocalBrowserDevicePollContract,
    );
    const pendingPoll = await accept(
      pollClient.poll({
        body: {
          deviceCode: startResponse.body.deviceCode,
          pollToken: startResponse.body.pollToken,
        },
      }),
      [200],
    );
    expect(pendingPoll.body).toStrictEqual({ status: "pending" });

    await createOrgFixture();
    const claimClient = setupApp({ context })(
      zeroLocalBrowserDeviceClaimContract,
    );
    const claimResponse = await accept(
      claimClient.claim({
        body: { deviceCode: startResponse.body.userCode },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(claimResponse.body).toStrictEqual({ status: "approved" });

    const linkedPoll = await accept(
      pollClient.poll({
        body: {
          deviceCode: startResponse.body.deviceCode,
          pollToken: startResponse.body.pollToken,
        },
      }),
      [200],
    );
    expect(linkedPoll.body.status).toBe("linked");
    if (linkedPoll.body.status !== "linked") {
      throw new Error("expected linked local-browser poll response");
    }
    expect(linkedPoll.body.hostToken).toMatch(/^vm0_local_browser_host_/);

    const heartbeatClient = setupApp({ context })(
      zeroLocalBrowserHeartbeatContract,
    );
    const heartbeatResponse = await accept(
      heartbeatClient.heartbeat({
        body: {
          ...runtimeBody,
          extensionVersion: "0.2.0",
          supportedCapabilities: ["tabs.list", "tabs.capture"],
        },
        headers: { authorization: `Bearer ${linkedPoll.body.hostToken}` },
      }),
      [200],
    );
    expect(heartbeatResponse.body).toStrictEqual({
      ok: true,
      hostId: linkedPoll.body.hostId,
    });

    const realtimeClient = setupApp({ context })(
      zeroLocalBrowserHostRealtimeContract,
    );
    const realtimeResponse = await accept(
      realtimeClient.create({
        body: {},
        headers: { authorization: `Bearer ${linkedPoll.body.hostToken}` },
      }),
      [200],
    );
    expect(realtimeResponse.body.eventName).toBe("command");
    expect(realtimeResponse.body.channelName).toBe(
      `local-browser-host:${linkedPoll.body.hostId}`,
    );

    const hostsClient = setupApp({ context })(zeroLocalBrowserHostsContract);
    const hostsResponse = await accept(
      hostsClient.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(hostsResponse.body.hosts).toHaveLength(1);
    expect(hostsResponse.body.hosts[0]).toMatchObject({
      id: linkedPoll.body.hostId,
      displayName: runtimeBody.hostName,
      browser: runtimeBody.browser,
      extensionVersion: "0.2.0",
      supportedCapabilities: ["tabs.list", "tabs.capture"],
      status: "online",
    });
  });

  it("starts and deletes a signed-in host, then rejects further heartbeats", async () => {
    await createOrgFixture();
    const hostsClient = setupApp({ context })(zeroLocalBrowserHostsContract);
    const startResponse = await accept(
      hostsClient.start({
        body: runtimeBody,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(startResponse.body.hostToken).toMatch(/^vm0_local_browser_host_/);

    const heartbeatClient = setupApp({ context })(
      zeroLocalBrowserHeartbeatContract,
    );
    await accept(
      heartbeatClient.heartbeat({
        body: runtimeBody,
        headers: { authorization: `Bearer ${startResponse.body.hostToken}` },
      }),
      [200],
    );

    const deleteResponse = await accept(
      hostsClient.delete({
        params: { hostId: startResponse.body.hostId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(deleteResponse.body).toStrictEqual({ ok: true });

    const rejectedHeartbeat = await accept(
      heartbeatClient.heartbeat({
        body: runtimeBody,
        headers: { authorization: `Bearer ${startResponse.body.hostToken}` },
      }),
      [401],
    );
    expect(rejectedHeartbeat.body.error.code).toBe("UNAUTHORIZED");

    const hostsResponse = await accept(
      hostsClient.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(hostsResponse.body.hosts).toStrictEqual([]);
  });

  it("lets an extension revoke its own host token", async () => {
    await createOrgFixture();
    const hostsClient = setupApp({ context })(zeroLocalBrowserHostsContract);
    const startResponse = await accept(
      hostsClient.start({
        body: runtimeBody,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const selfClient = setupApp({ context })(zeroLocalBrowserHostSelfContract);
    const revokeResponse = await accept(
      selfClient.delete({
        headers: { authorization: `Bearer ${startResponse.body.hostToken}` },
      }),
      [200],
    );
    expect(revokeResponse.body).toStrictEqual({ ok: true });

    const heartbeatClient = setupApp({ context })(
      zeroLocalBrowserHeartbeatContract,
    );
    const rejectedHeartbeat = await accept(
      heartbeatClient.heartbeat({
        body: runtimeBody,
        headers: { authorization: `Bearer ${startResponse.body.hostToken}` },
      }),
      [401],
    );
    expect(rejectedHeartbeat.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects device approval when local browser use is disabled", async () => {
    const startClient = setupApp({ context })(
      zeroLocalBrowserDeviceStartContract,
    );
    const startResponse = await accept(
      startClient.start({ body: runtimeBody }),
      [200],
    );
    trackDeviceCode(startResponse.body.deviceCode);

    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const fixture = await store.set(
      seedOrgMembership$,
      { orgId, userId },
      context.signal,
    );
    seededFixtures.push(fixture);
    trackedOrgIds.push(orgId);
    mocks.clerk.session(userId, orgId);

    const claimClient = setupApp({ context })(
      zeroLocalBrowserDeviceClaimContract,
    );
    const response = await accept(
      claimClient.claim({
        body: { deviceCode: startResponse.body.userCode },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});
