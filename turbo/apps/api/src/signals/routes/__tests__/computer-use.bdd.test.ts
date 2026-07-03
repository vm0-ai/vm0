import { randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type {
  TestComputerUseStateGetResponse,
  TestComputerUseStatePostResponse,
} from "@vm0/api-contracts/contracts/test-computer-use-state";
import {
  COMPUTER_USE_FILESYSTEM_PLUGIN,
  COMPUTER_USE_PLUGIN_CALL_KIND,
  computerUsePluginCapability,
  computerUsePluginToolCapability,
} from "@vm0/api-contracts/contracts/zero-computer-use-plugins";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { createAppWithRoutes } from "../../../app-factory-core";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-context";
import { testComputerUseStateRoutes } from "../test-computer-use-state";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import {
  createComputerUseBddApi,
  zeroComputerUseToken,
} from "./helpers/api-bdd-computer-use";
import { mockClerkMembership } from "./helpers/api-bdd-github";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createFixtureTracker } from "./helpers/zero-route-test";

/*
 * FILE-03 timing notes:
 * - Hosts count as online for COMPUTER_USE_HOST_CLOSED_AFTER_MS (90s) after
 *   their last heartbeat/claim. The offline/ambiguous constructions below
 *   move mocked time forward (+91s/+120s) and rely on host heartbeat/claim
 *   calls refreshing lastSeenAt (#15750) to bring a stale host back online.
 * - The screenshot retention chain builds >30-day-old rows by running the
 *   full command flow under mockNow(now - 40d), then clears the mock before
 *   invoking the cleanup cron so the retention cutoff is computed at real
 *   time. The cleanup cron is a global sweep; see the single-file-ownership
 *   comment on runComputerUseScreenshotCleanupCron.
 */

const context = testContext();
const bdd = createBddApi(context);
const api = createComputerUseBddApi(context);
const COMPUTER_USE_STATE_ROUTE = "/api/test/computer-use-state";

afterEach(() => {
  clearMockNow();
});

function requireOrg(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected test actor to have an org");
  }
  return actor.orgId;
}

async function enableComputerUseDesktopPlugins(
  actor: ApiTestUser,
): Promise<void> {
  await updateFeatureSwitchesForUser(
    context,
    {
      userId: actor.userId,
      orgId: requireOrg(actor),
      orgRole: actor.orgRole,
    },
    {
      [FeatureSwitchKey.ComputerUseDesktopPlugins]: true,
    },
  );
}

function filesystemToolCapabilities(tool: "read_text_file"): readonly string[] {
  return [
    COMPUTER_USE_PLUGIN_CALL_KIND,
    computerUsePluginCapability(COMPUTER_USE_FILESYSTEM_PLUGIN),
    computerUsePluginToolCapability(COMPUTER_USE_FILESYSTEM_PLUGIN, tool),
  ];
}

interface ComputerUseRunFixture {
  readonly composeId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly threadId: string | null;
  readonly slack: TestComputerUseStatePostResponse["slack"];
}

function requestComputerUseState(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testComputerUseStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function deleteComputerUseRunFixture(
  fixture: ComputerUseRunFixture,
): Promise<void> {
  await requestComputerUseState(
    `${COMPUTER_USE_STATE_ROUTE}?run_id=${encodeURIComponent(fixture.runId)}`,
    { method: "DELETE" },
  );
}

const trackComputerUseRun = createFixtureTracker(deleteComputerUseRunFixture);

async function seedZeroRun(args: {
  readonly actor: ApiTestUser;
  readonly triggerSource: "web" | "slack";
}): Promise<ComputerUseRunFixture> {
  const response = await requestComputerUseState(COMPUTER_USE_STATE_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user_id: args.actor.userId,
      org_id: requireOrg(args.actor),
      trigger_source: args.triggerSource,
    }),
  });
  expect(response.status).toBe(200);
  const body = await readJson<TestComputerUseStatePostResponse>(response);
  const fixture = {
    composeId: body.compose_id,
    runId: body.run_id,
    sessionId: body.session_id,
    threadId: body.thread_id,
    slack: body.slack,
  };
  return await trackComputerUseRun(Promise.resolve(fixture));
}

async function readComputerUseRunState(
  runId: string,
): Promise<TestComputerUseStateGetResponse> {
  const response = await requestComputerUseState(
    `${COMPUTER_USE_STATE_ROUTE}?run_id=${encodeURIComponent(runId)}`,
  );
  expect(response.status).toBe(200);
  return await readJson<TestComputerUseStateGetResponse>(response);
}

function requestTokenFromUrl(authorizationUrl: string): string {
  const url = new URL(authorizationUrl);
  const prefix = "/computer-use/authorize/";
  if (!url.pathname.startsWith(prefix)) {
    throw new Error(`Unexpected authorization URL: ${authorizationUrl}`);
  }
  return decodeURIComponent(url.pathname.slice(prefix.length));
}

describe("FILE-03 desktop computer-use runtime", () => {
  it("does not expose the legacy computer-use command approval route", async () => {
    const app = createApp({ signal: context.signal });
    const response = await app.request(
      `/api/zero/computer-use/commands/${randomUUID()}/approval`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      },
    );

    expect(response.status).toBe(404);
  });

  it("creates a delegated authorization link and applies the selected host to the chat thread", async () => {
    const orgId = `org_${randomUUID()}`;
    const actor = bdd.user({ orgId });
    const run = await seedZeroRun({ actor, triggerSource: "web" });
    if (!run.threadId) {
      throw new Error("Expected web run fixture to create a chat thread");
    }

    const host = await api.startComputerUseHost(actor, {
      hostName: "Studio Mac",
    });
    mockClerkMembership(context, actor, "org:admin");
    const token = zeroComputerUseToken({
      userId: actor.userId,
      orgId,
      runId: run.runId,
      capabilities: ["connector:read"],
    }).token;

    const created = await api.createComputerUseAuthorizationRequest({
      bearer: token,
    });
    expect(created).toMatchObject({
      source: "chat",
    });
    expect(created.authorizationUrl).toContain("/computer-use/authorize/");

    const requestToken = requestTokenFromUrl(created.authorizationUrl);
    const readable = await api.readComputerUseAuthorizationRequest(
      actor,
      requestToken,
    );
    expect(readable).toMatchObject({
      source: "chat",
      completedAt: null,
      computerUseHostId: null,
      hosts: [expect.objectContaining({ id: host.hostId })],
    });

    const applied = await api.applyComputerUseAuthorizationRequest(
      actor,
      requestToken,
      host.hostId,
    );
    expect(applied).toStrictEqual({
      ok: true,
      source: "chat",
      computerUseHostId: host.hostId,
    });

    await expect(readComputerUseRunState(run.runId)).resolves.toStrictEqual({
      source: "web",
      computer_use_host_id: host.hostId,
    });

    const completed = await api.readComputerUseAuthorizationRequest(
      actor,
      requestToken,
    );
    expect(completed.completedAt).not.toBeNull();
    expect(completed.computerUseHostId).toBe(host.hostId);
  });

  it("only exposes online hosts for delegated authorization requests", async () => {
    const orgId = `org_${randomUUID()}`;
    const actor = bdd.user({ orgId });
    const run = await seedZeroRun({ actor, triggerSource: "web" });
    if (!run.threadId) {
      throw new Error("Expected web run fixture to create a chat thread");
    }

    const base = now();
    mockNow(base);
    const staleHost = await api.startComputerUseHost(actor, {
      hostName: "Stale Mac",
    });
    const stoppedHost = await api.startComputerUseHost(actor, {
      installationId: randomUUID(),
      hostName: "Closed Mac",
    });
    await api.stopComputerUseHost(stoppedHost.hostToken);

    mockNow(base + 120_000);
    const onlineHost = await api.startComputerUseHost(actor, {
      hostName: "Studio Mac",
    });
    mockClerkMembership(context, actor, "org:admin");
    const token = zeroComputerUseToken({
      userId: actor.userId,
      orgId,
      runId: run.runId,
      capabilities: ["connector:read"],
    }).token;

    const created = await api.createComputerUseAuthorizationRequest({
      bearer: token,
    });
    const requestToken = requestTokenFromUrl(created.authorizationUrl);
    const readable = await api.readComputerUseAuthorizationRequest(
      actor,
      requestToken,
    );
    expect(
      readable.hosts.map((host) => {
        return host.id;
      }),
    ).toStrictEqual([onlineHost.hostId]);

    const staleApply = await api.requestApplyComputerUseAuthorizationRequest(
      actor,
      requestToken,
      staleHost.hostId,
      [404],
    );
    expectApiError(staleApply.body);
    expect(staleApply.body.error.message).toBe("Computer-use host not found");

    const stoppedApply = await api.requestApplyComputerUseAuthorizationRequest(
      actor,
      requestToken,
      stoppedHost.hostId,
      [404],
    );
    expectApiError(stoppedApply.body);
    expect(stoppedApply.body.error.message).toBe("Computer-use host not found");

    const applied = await api.applyComputerUseAuthorizationRequest(
      actor,
      requestToken,
      onlineHost.hostId,
    );
    expect(applied).toStrictEqual({
      ok: true,
      source: "chat",
      computerUseHostId: onlineHost.hostId,
    });

    await expect(readComputerUseRunState(run.runId)).resolves.toStrictEqual({
      source: "web",
      computer_use_host_id: onlineHost.hostId,
    });
  });

  it("creates a delegated authorization link and applies the selected host to the Slack thread", async () => {
    const orgId = `org_${randomUUID()}`;
    const actor = bdd.user({ orgId });
    const run = await seedZeroRun({ actor, triggerSource: "slack" });

    const host = await api.startComputerUseHost(actor, {
      hostName: "Slack Desktop",
    });
    mockClerkMembership(context, actor, "org:admin");
    const token = zeroComputerUseToken({
      userId: actor.userId,
      orgId,
      runId: run.runId,
      capabilities: ["connector:read"],
    }).token;

    const created = await api.createComputerUseAuthorizationRequest({
      bearer: token,
    });
    expect(created.source).toBe("slack");

    const requestToken = requestTokenFromUrl(created.authorizationUrl);
    const applied = await api.applyComputerUseAuthorizationRequest(
      actor,
      requestToken,
      host.hostId,
    );
    expect(applied).toStrictEqual({
      ok: true,
      source: "slack",
      computerUseHostId: host.hostId,
    });

    await expect(readComputerUseRunState(run.runId)).resolves.toStrictEqual({
      source: "slack",
      computer_use_host_id: host.hostId,
    });
  });

  it("chains host start, command claim, completion, audit, and host deletion", async () => {
    const orgId = `org_${randomUUID()}`;
    const actor = bdd.user({ orgId });
    const peer = bdd.user({ orgId });

    const initialHosts = await api.listComputerUseHosts(actor);
    expect(initialHosts.hosts).toStrictEqual([]);

    const hostName = "lancy-macbook-pro.local";
    const host = await api.startComputerUseHost(actor, { hostName });
    expect(host.hostToken).toMatch(/^vm0_computer_use_host_/);

    const hosts = await api.listComputerUseHosts(actor);
    expect(hosts.hosts).toHaveLength(1);
    expect(hosts.hosts[0]).toMatchObject({
      id: host.hostId,
      hostName,
      displayName: hostName,
      status: "online",
      permissions: { accessibility: true, screenRecording: true },
    });

    const createdCommand = await api.createComputerUseWriteCommand(actor);
    expect(createdCommand).toMatchObject({ status: "queued" });

    const claimed = await api.claimNextComputerUseCommand(host.hostToken);
    expect(claimed.status).toBe("command");
    if (claimed.status !== "command") {
      throw new Error("Expected queued computer-use command to be claimed");
    }
    expect(claimed.command.id).toBe(createdCommand.commandId);
    expect(claimed.command.kind).toBe("app.open");

    await api.completeComputerUseCommand(
      host.hostToken,
      createdCommand.commandId,
    );

    const completedCommand = await api.readComputerUseCommand(
      actor,
      createdCommand.commandId,
    );
    expect(completedCommand).toMatchObject({
      id: createdCommand.commandId,
      kind: "app.open",
      status: "succeeded",
      hostId: host.hostId,
    });

    const peerRead = await api.requestReadComputerUseCommand(
      peer,
      createdCommand.commandId,
      [403, 404],
    );
    expectApiError(peerRead.body);
    expect(["FORBIDDEN", "NOT_FOUND"]).toContain(peerRead.body.error.code);

    const missingScreenshot = await api.requestComputerUseScreenshot(
      actor,
      createdCommand.commandId,
      [404],
    );
    expectApiError(missingScreenshot.body);
    expect(missingScreenshot.body.error.code).toBe("NOT_FOUND");

    const audit = await api.listComputerUseAuditEvents(actor, {
      commandId: createdCommand.commandId,
    });
    expect(
      audit.auditEvents.map((event) => {
        return event.event;
      }),
    ).toStrictEqual(expect.arrayContaining(["completed"]));

    await api.stopComputerUseHost(host.hostToken);
    const afterDelete = await api.listComputerUseHosts(actor);
    expect(
      afterDelete.hosts.some((item) => {
        return item.id === host.hostId;
      }),
    ).toBeFalsy();
  });

  it("keeps multiple active hosts and lets stale heartbeats recover", async () => {
    const actor = bdd.user();
    const base = now();
    mockNow(base);

    const first = await api.startComputerUseHost(actor, {
      hostName: "Zero Desktop",
    });
    const heartbeat = await api.heartbeatComputerUseHost(first.hostToken);
    expect(heartbeat).toStrictEqual({ ok: true, hostId: first.hostId });

    mockNow(base + 120_000);
    const second = await api.startComputerUseHost(actor, {
      hostName: "Studio Mac",
    });
    expect(second.hostId).not.toBe(first.hostId);

    const staleHeartbeat = await api.heartbeatComputerUseHost(first.hostToken);
    expect(staleHeartbeat).toStrictEqual({ ok: true, hostId: first.hostId });

    const visibleHosts = await api.listComputerUseHosts(actor);
    expect(visibleHosts.hosts).toHaveLength(2);
    expect(visibleHosts.hosts).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.hostId,
          hostName: "Zero Desktop",
          status: "online",
        }),
        expect.objectContaining({
          id: second.hostId,
          hostName: "Studio Mac",
          status: "online",
        }),
      ]),
    );

    const stopped = await api.stopComputerUseHost(second.hostToken);
    expect(stopped).toStrictEqual({ ok: true, hostId: second.hostId });

    const restarted = await api.startComputerUseHost(actor, {
      hostName: "Recovered Desktop",
    });
    expect(restarted.hostId).not.toBe(second.hostId);

    const missingDelete = await api.requestDeleteComputerUseHost(
      actor,
      randomUUID(),
      [404],
    );
    expectApiError(missingDelete.body);
    expect(missingDelete.body.error.message).toBe(
      "Computer-use host not found",
    );

    await api.deleteComputerUseHost(actor, restarted.hostId);
    const afterDelete = await api.listComputerUseHosts(actor);
    expect(
      afterDelete.hosts.map((item) => {
        return item.id;
      }),
    ).toStrictEqual([first.hostId]);
  });

  it("keeps installation hosts stable across stop and restart", async () => {
    const actor = bdd.user();
    const installationId = randomUUID();

    const started = await api.startComputerUseHost(actor, {
      installationId,
      hostName: "Studio Mac",
    });

    await api.stopComputerUseHost(started.hostToken);
    const stoppedHeartbeat = await api.requestComputerUseHeartbeat(
      started.hostToken,
      [401],
    );
    expectApiError(stoppedHeartbeat.body);
    expect(stoppedHeartbeat.body.error.message).toBe(
      "Invalid computer-use host token",
    );

    const stoppedHosts = await api.listComputerUseHosts(actor);
    expect(stoppedHosts.hosts).toStrictEqual([
      expect.objectContaining({
        id: started.hostId,
        hostName: "Studio Mac",
        status: "offline",
      }),
    ]);

    const restarted = await api.startComputerUseHost(actor, {
      installationId,
      hostName: "Renamed Studio Mac",
    });
    expect(restarted.hostId).toBe(started.hostId);
    expect(restarted.hostToken).not.toBe(started.hostToken);

    const restartedHosts = await api.listComputerUseHosts(actor);
    expect(restartedHosts.hosts).toStrictEqual([
      expect.objectContaining({
        id: started.hostId,
        hostName: "Renamed Studio Mac",
        status: "online",
      }),
    ]);
  });

  it("publishes computer-use host list changes", async () => {
    const actor = bdd.user();
    const base = now();
    mockNow(base);

    context.mocks.ably.publish.mockClear();
    const host = await api.startComputerUseHost(actor, {
      hostName: "Studio Mac",
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "computerUseHostsChanged",
      null,
    );

    context.mocks.ably.publish.mockClear();
    await api.heartbeatComputerUseHost(host.hostToken, {
      hostName: "Studio Mac",
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    mockNow(base + 120_000);
    await api.heartbeatComputerUseHost(host.hostToken, {
      hostName: "Studio Mac",
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "computerUseHostsChanged",
      null,
    );

    context.mocks.ably.publish.mockClear();
    await api.stopComputerUseHost(host.hostToken);
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "computerUseHostsChanged",
      null,
    );

    clearMockNow();
    const restarted = await api.startComputerUseHost(actor, {
      hostName: "Recovered Desktop",
    });
    context.mocks.ably.publish.mockClear();
    await api.deleteComputerUseHost(actor, restarted.hostId);
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "computerUseHostsChanged",
      null,
    );
  });

  it("rejects host-token routes with missing or invalid host tokens", async () => {
    const garbageToken = "vm0-bdd-garbage-host-token";
    const commandId = randomUUID();
    const completeBody = {
      status: "succeeded" as const,
      result: { app: "Safari", opened: true },
    };

    const missingHeartbeat = await api.requestComputerUseHeartbeat(null, [401]);
    expectApiError(missingHeartbeat.body);
    expect(missingHeartbeat.body.error.message).toBe(
      "Missing computer-use host token",
    );

    const invalidHeartbeat = await api.requestComputerUseHeartbeat(
      garbageToken,
      [401],
    );
    expectApiError(invalidHeartbeat.body);
    expect(invalidHeartbeat.body.error.message).toBe(
      "Invalid computer-use host token",
    );

    const missingStop = await api.requestStopComputerUseHost(null, [401]);
    expectApiError(missingStop.body);
    expect(missingStop.body.error.message).toBe(
      "Missing computer-use host token",
    );

    const invalidStop = await api.requestStopComputerUseHost(
      garbageToken,
      [401],
    );
    expectApiError(invalidStop.body);
    expect(invalidStop.body.error.message).toBe(
      "Invalid computer-use host token",
    );

    const missingNext = await api.requestClaimNextComputerUseCommand(
      null,
      [401],
    );
    expectApiError(missingNext.body);
    expect(missingNext.body.error.message).toBe(
      "Missing computer-use host token",
    );

    const invalidNext = await api.requestClaimNextComputerUseCommand(
      garbageToken,
      [401],
    );
    expectApiError(invalidNext.body);
    expect(invalidNext.body.error.message).toBe(
      "Invalid computer-use host token",
    );

    const missingComplete = await api.requestCompleteComputerUseCommand(
      null,
      commandId,
      completeBody,
      [401],
    );
    expectApiError(missingComplete.body);
    expect(missingComplete.body.error.message).toBe(
      "Missing computer-use host token",
    );

    const invalidComplete = await api.requestCompleteComputerUseCommand(
      garbageToken,
      commandId,
      completeBody,
      [401],
    );
    expectApiError(invalidComplete.body);
    expect(invalidComplete.body.error.message).toBe(
      "Invalid computer-use host token",
    );
  });

  it("routes commands across offline, unsupported, ambiguous, and granted hosts", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const actor = bdd.user({ orgId, userId });

    const noHost = await api.requestCreateComputerUseReadCommand(
      actor,
      { kind: "apps.list" },
      [404],
    );
    expectApiError(noHost.body);
    expect(noHost.body.error.message).toBe("No linked computer-use host found");

    const base = now();
    mockNow(base);
    const hostA = await api.startComputerUseHost(actor);

    mockNow(base + 91_000);
    const offline = await api.requestCreateComputerUseReadCommand(
      actor,
      { kind: "apps.list" },
      [409],
    );
    expectApiError(offline.body);
    expect(offline.body.error.message).toBe(
      "No online computer-use host found",
    );

    const hostB = await api.startComputerUseHost(actor, {
      supportedCapabilities: ["apps.list", "element.click"],
    });

    const unsupported = await api.requestCreateComputerUseReadCommand(
      actor,
      { kind: "app.state", app: "Safari" },
      [409],
    );
    expectApiError(unsupported.body);
    expect(unsupported.body.error.message).toBe(
      "No online computer-use host supports this command",
    );

    // Claim polls refresh lastSeenAt, so host A's idle poll puts both hosts
    // online again for the ambiguity case.
    const idleA = await api.claimNextComputerUseCommand(hostA.hostToken);
    expect(idleA.status).toBe("idle");

    const ambiguous = await api.requestCreateComputerUseReadCommand(
      actor,
      { kind: "apps.list" },
      [409],
    );
    expectApiError(ambiguous.body);
    expect(ambiguous.body.error.message).toBe(
      "Multiple active computer-use hosts are online",
    );

    // Zero-token auth resolves the org role through membershipsByUserId.
    mockClerkMembership(context, actor, "org:admin");

    const missingCapability = await api.requestCreateComputerUseReadCommand(
      {
        bearer: zeroComputerUseToken({
          userId,
          orgId,
          capabilities: ["connector:read"],
        }).token,
      },
      { kind: "apps.list" },
      [403],
    );
    expectApiError(missingCapability.body);
    expect(missingCapability.body.error.message).toBe(
      "Missing required capability: computer-use:write",
    );

    const ungranted = await api.requestCreateComputerUseReadCommand(
      {
        bearer: zeroComputerUseToken({
          userId,
          orgId,
          capabilities: ["computer-use:write"],
        }).token,
      },
      { kind: "apps.list" },
      [403],
    );
    expectApiError(ungranted.body);
    expect(ungranted.body.error.message).toBe(
      "Computer-use host is not authorized for this run",
    );

    const granted = zeroComputerUseToken({
      userId,
      orgId,
      capabilities: ["computer-use:write"],
      computerUseHostId: hostB.hostId,
    });
    const readCreated = await api.createComputerUseReadCommand(
      { bearer: granted.token },
      { kind: "apps.list" },
    );
    expect(readCreated.status).toBe("queued");

    const idleAfterGrant = await api.claimNextComputerUseCommand(
      hostA.hostToken,
    );
    expect(idleAfterGrant.status).toBe("idle");

    const claimedRead = await api.claimNextComputerUseCommand(hostB.hostToken);
    expect(claimedRead.status).toBe("command");
    if (claimedRead.status !== "command") {
      throw new Error("Expected the granted host to claim the read command");
    }
    expect(claimedRead.command).toMatchObject({
      id: readCreated.commandId,
      hostId: hostB.hostId,
      kind: "apps.list",
      status: "running",
    });

    await api.completeComputerUseCommandWith(
      hostB.hostToken,
      readCreated.commandId,
      { status: "succeeded", result: { apps: ["Safari"] } },
    );

    const writeCreated = await api.createComputerUseWriteCommand(
      { bearer: granted.token },
      {
        kind: "element.click",
        app: "Safari",
        snapshotId: "snap_bdd",
        elementIndex: 7,
        button: "left",
        clickCount: 1,
        timeoutMs: 15_000,
      },
    );
    expect(writeCreated.status).toBe("queued");

    const claimedWrite = await api.claimNextComputerUseCommand(hostB.hostToken);
    expect(claimedWrite.status).toBe("command");
    if (claimedWrite.status !== "command") {
      throw new Error("Expected the granted host to claim the write command");
    }
    expect(claimedWrite.command).toMatchObject({
      id: writeCreated.commandId,
      hostId: hostB.hostId,
      kind: "element.click",
      status: "running",
      payload: {
        app: "Safari",
        snapshotId: "snap_bdd",
        elementIndex: 7,
        button: "left",
        clickCount: 1,
      },
    });

    await api.completeComputerUseCommandWith(
      hostB.hostToken,
      writeCreated.commandId,
      {
        status: "succeeded",
        result: {
          summary: "Clicked elementIndex=7",
          elementIndex: 7,
          dispatchMode: "accessibility_action",
          dispatchTarget: "element",
          inputRisk: "targeted_app_action",
          appState: "Computer Use state\n<app_state>\n</app_state>",
          truncated: true,
          truncationReasons: ["max_nodes"],
          metrics: {
            helperDurationMs: 42,
            settle: true,
            rawNodeCount: 5,
            nodeCount: 3,
            appStateChars: 43,
            visibleElementCount: 2,
          },
        },
      },
    );

    const audit = await api.listComputerUseAuditEvents(actor, {
      runId: granted.runId,
      hostId: hostB.hostId,
    });
    expect(audit.auditEvents).toHaveLength(1);
    expect(audit.auditEvents[0]).toMatchObject({
      commandId: writeCreated.commandId,
      runId: granted.runId,
      hostId: hostB.hostId,
      kind: "element.click",
      event: "completed",
      redactedResult: {
        summary: "Clicked elementIndex=7",
        elementIndex: 7,
        dispatchMode: "accessibility_action",
        dispatchTarget: "element",
        inputRisk: "targeted_app_action",
        appStateLength: 43,
        truncated: true,
        truncationReasons: ["max_nodes"],
        metrics: {
          helperDurationMs: 42,
          settle: true,
          rawNodeCount: 5,
          nodeCount: 3,
          appStateChars: 43,
          visibleElementCount: 2,
        },
      },
    });
    expect(JSON.stringify(audit.auditEvents[0]?.redactedResult)).not.toContain(
      "<app_state>",
    );

    mockNow(base + 182_000);
    const idleB = await api.claimNextComputerUseCommand(hostB.hostToken);
    expect(idleB.status).toBe("idle");

    const grantedOffline = zeroComputerUseToken({
      userId,
      orgId,
      capabilities: ["computer-use:write"],
      computerUseHostId: hostA.hostId,
    });
    const offlineGrant = await api.requestCreateComputerUseReadCommand(
      { bearer: grantedOffline.token },
      { kind: "apps.list" },
      [409],
    );
    expectApiError(offlineGrant.body);
    expect(offlineGrant.body.error.message).toBe(
      "No online computer-use host found",
    );
  });

  it("gates plugin commands by feature switch and routes them by tool capability", async () => {
    const actor = bdd.user();

    const disabled = await api.requestCreateComputerUsePluginCommand(
      actor,
      {
        plugin: "filesystem",
        tool: "read_text_file",
        arguments: { path: "/tmp/notes.txt" },
      },
      [403],
    );
    expectApiError(disabled.body);
    expect(disabled.body.error.message).toBe(
      "Computer Use Desktop plugins are disabled",
    );

    await enableComputerUseDesktopPlugins(actor);
    const unsupportedHost = await api.startComputerUseHost(actor);

    const unsupported = await api.requestCreateComputerUsePluginCommand(
      actor,
      {
        plugin: "filesystem",
        tool: "read_text_file",
        arguments: { path: "/tmp/notes.txt" },
      },
      [409],
    );
    expectApiError(unsupported.body);
    expect(unsupported.body.error.message).toBe(
      "No online computer-use host supports this plugin tool",
    );

    const pluginCapabilities = filesystemToolCapabilities("read_text_file");
    const pluginHost = await api.startComputerUseHost(actor, {
      supportedCapabilities: pluginCapabilities,
    });
    const created = await api.createComputerUsePluginCommand(actor, {
      plugin: "filesystem",
      tool: "read_text_file",
      arguments: { path: "/tmp/notes.txt" },
    });

    const unsupportedClaim = await api.claimNextComputerUseCommand(
      unsupportedHost.hostToken,
    );
    expect(unsupportedClaim.status).toBe("idle");

    const claimed = await api.claimNextComputerUseCommand(
      pluginHost.hostToken,
      pluginCapabilities,
    );
    expect(claimed.status).toBe("command");
    if (claimed.status !== "command") {
      throw new Error("Expected plugin host to claim the plugin command");
    }
    expect(claimed.command).toMatchObject({
      id: created.commandId,
      hostId: pluginHost.hostId,
      kind: "plugin.call",
      payload: {
        plugin: "filesystem",
        tool: "read_text_file",
        arguments: { path: "/tmp/notes.txt" },
      },
    });
  });

  it("offloads filesystem plugin content and records metadata-only audit", async () => {
    const fake = api.installComputerUseS3Fake();
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const actor = bdd.user({ orgId, userId });
    await enableComputerUseDesktopPlugins(actor);

    const pluginCapabilities = filesystemToolCapabilities("read_text_file");
    const host = await api.startComputerUseHost(actor, {
      supportedCapabilities: pluginCapabilities,
    });
    mockClerkMembership(context, actor, "org:admin");
    const granted = zeroComputerUseToken({
      userId,
      orgId,
      capabilities: ["computer-use:write"],
      computerUseHostId: host.hostId,
    });

    const created = await api.createComputerUsePluginCommand(
      { bearer: granted.token },
      {
        plugin: "filesystem",
        tool: "read_text_file",
        arguments: { path: "/tmp/notes.txt" },
      },
    );
    const claimed = await api.claimNextComputerUseCommand(
      host.hostToken,
      pluginCapabilities,
    );
    expect(claimed.status).toBe("command");

    const content = Buffer.from("private local notes");
    await api.completeComputerUseCommandWith(
      host.hostToken,
      created.commandId,
      {
        status: "succeeded",
        result: {
          plugin: "filesystem",
          tool: "read_text_file",
          sizeBytes: content.length,
          pluginContent: {
            dataBase64: content.toString("base64"),
            mimeType: "text/plain",
            fileName: "notes.txt",
          },
        },
      },
    );

    const key = `computer-use/${orgId}/${userId}/${created.commandId}/plugin-content.txt`;
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0]).toMatchObject({
      bucket: "test-user-storages",
      key,
      contentType: "text/plain",
    });
    expect(fake.puts[0]?.body.equals(content)).toBeTruthy();

    const detail = await api.readComputerUseCommand(actor, created.commandId);
    expect(detail.result?.pluginContent).toStrictEqual({
      type: "s3",
      mimeType: "text/plain",
      sizeBytes: content.length,
      fileName: "notes.txt",
    });
    expect(JSON.stringify(detail.result)).not.toContain(
      content.toString("base64"),
    );

    const downloaded = await api.downloadComputerUsePluginContent(
      actor,
      created.commandId,
    );
    expect(downloaded.contentType).toBe("text/plain");
    expect(downloaded.fileName).toBe("notes.txt");
    expect(downloaded.bytes.equals(content)).toBeTruthy();

    const audit = await api.listComputerUseAuditEvents(actor, {
      runId: granted.runId,
      hostId: host.hostId,
    });
    expect(audit.auditEvents).toHaveLength(1);
    expect(audit.auditEvents[0]).toMatchObject({
      commandId: created.commandId,
      runId: granted.runId,
      hostId: host.hostId,
      kind: "plugin.call",
      redactedResult: {
        plugin: "filesystem",
        tool: "read_text_file",
        status: "succeeded",
        destructive: false,
        path: "/tmp/notes.txt",
        offloaded: true,
        sizeBytes: content.length,
        fileName: "notes.txt",
        mimeType: "text/plain",
      },
    });
    expect(JSON.stringify(audit.auditEvents[0]?.redactedResult)).not.toContain(
      "private local notes",
    );
  });

  it("times out stale running commands and reports completion failures", async () => {
    const actor = bdd.user();
    const base = now();
    mockNow(base);
    const host = await api.startComputerUseHost(actor);

    const first = await api.createComputerUseReadCommand(actor, {
      kind: "app.state",
      app: "Safari",
      timeoutMs: 1000,
    });

    const claimedFirst = await api.claimNextComputerUseCommand(host.hostToken);
    expect(claimedFirst.status).toBe("command");
    if (claimedFirst.status !== "command") {
      throw new Error("Expected the first command to be claimed");
    }
    expect(claimedFirst.command.id).toBe(first.commandId);

    const idleWhileRunning = await api.claimNextComputerUseCommand(
      host.hostToken,
    );
    expect(idleWhileRunning.status).toBe("idle");

    const second = await api.createComputerUseReadCommand(actor, {
      kind: "apps.list",
    });

    const queuedComplete = await api.requestCompleteComputerUseCommand(
      host.hostToken,
      second.commandId,
      { status: "succeeded", result: {} },
      [409],
    );
    expectApiError(queuedComplete.body);
    expect(queuedComplete.body.error.message).toBe(
      "Computer-use command is not running",
    );

    mockNow(base + 1500);
    const claimedSecond = await api.claimNextComputerUseCommand(host.hostToken);
    expect(claimedSecond.status).toBe("command");
    if (claimedSecond.status !== "command") {
      throw new Error("Expected the second command after the stale timeout");
    }
    expect(claimedSecond.command.id).toBe(second.commandId);

    const timedOut = await api.readComputerUseCommand(actor, first.commandId);
    expect(timedOut).toMatchObject({
      status: "failed",
      error: {
        code: "timeout",
        message: "Computer-use command timed out after 1000ms",
      },
    });
    expect(timedOut.completedAt).toBe(new Date(base + 1500).toISOString());

    await api.completeComputerUseCommandWith(host.hostToken, second.commandId, {
      status: "failed",
      error: { code: "app_not_found", message: "Finder is not available" },
    });
    const failed = await api.readComputerUseCommand(actor, second.commandId);
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "app_not_found", message: "Finder is not available" },
    });

    const duplicateComplete = await api.requestCompleteComputerUseCommand(
      host.hostToken,
      second.commandId,
      { status: "succeeded", result: {} },
      [200],
    );
    expect(duplicateComplete.body).toStrictEqual({ ok: true });
    const stillFailed = await api.readComputerUseCommand(
      actor,
      second.commandId,
    );
    expect(stillFailed).toMatchObject({
      status: "failed",
      error: { code: "app_not_found", message: "Finder is not available" },
    });

    const unknownComplete = await api.requestCompleteComputerUseCommand(
      host.hostToken,
      randomUUID(),
      { status: "succeeded", result: {} },
      [404],
    );
    expectApiError(unknownComplete.body);
    expect(unknownComplete.body.error.message).toBe(
      "Computer-use command not found",
    );
  });

  it("offloads, proxies, and expires screenshots through the retention cron", async () => {
    const fake = api.installComputerUseS3Fake();
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const actor = bdd.user({ orgId, userId });
    const peer = bdd.user();

    mockNow(now() - 40 * 24 * 60 * 60 * 1000);
    const host = await api.startComputerUseHost(actor);

    const first = await api.createComputerUseReadCommand(actor, {
      kind: "app.state",
      app: "Safari",
    });
    const claimedFirst = await api.claimNextComputerUseCommand(host.hostToken);
    expect(claimedFirst.status).toBe("command");

    const pngBytes = Buffer.from("bdd-screenshot-png-bytes");
    const screenshotBase64 = pngBytes.toString("base64");
    await api.completeComputerUseCommandWith(host.hostToken, first.commandId, {
      status: "succeeded",
      result: {
        snapshotId: "snap_bdd_old",
        screenshot: `data:image/png;base64,${screenshotBase64}`,
        screenshotWidth: 1363,
        screenshotHeight: 1200,
      },
    });

    const firstKey = `computer-use/${orgId}/${userId}/${first.commandId}/screenshot.png`;
    expect(fake.puts).toHaveLength(1);
    expect(fake.puts[0]).toMatchObject({
      bucket: "test-user-storages",
      key: firstKey,
      contentType: "image/png",
    });
    expect(fake.puts[0]?.body.equals(pngBytes)).toBeTruthy();

    const firstDetail = await api.readComputerUseCommand(
      actor,
      first.commandId,
    );
    expect(firstDetail.result?.screenshot).toStrictEqual({
      type: "s3",
      mimeType: "image/png",
      sizeBytes: pngBytes.length,
      width: 1363,
      height: 1200,
    });
    expect(JSON.stringify(firstDetail.result)).not.toContain(screenshotBase64);

    const download = await api.downloadComputerUseScreenshot(
      actor,
      first.commandId,
    );
    expect(download.contentType).toBe("image/png");
    expect(download.bytes.equals(pngBytes)).toBeTruthy();

    const peerScreenshot = await api.requestComputerUseScreenshot(
      peer,
      first.commandId,
      [404],
    );
    expectApiError(peerScreenshot.body);
    expect(peerScreenshot.body.error.code).toBe("NOT_FOUND");

    const second = await api.createComputerUseReadCommand(actor, {
      kind: "app.state",
      app: "Safari",
    });
    await api.claimNextComputerUseCommand(host.hostToken);
    await api.completeComputerUseCommandWith(host.hostToken, second.commandId, {
      status: "succeeded",
      result: {
        snapshotId: "snap_bdd_legacy",
        screenshot: "legacy-inline-screenshot",
      },
    });

    const secondDetail = await api.readComputerUseCommand(
      actor,
      second.commandId,
    );
    expect(secondDetail.result).toMatchObject({
      screenshot: "legacy-inline-screenshot",
    });
    const legacyScreenshot = await api.requestComputerUseScreenshot(
      actor,
      second.commandId,
      [404],
    );
    expectApiError(legacyScreenshot.body);
    expect(legacyScreenshot.body.error.code).toBe("NOT_FOUND");

    // Back to real time: the retention cutoff must be computed against the
    // wall clock so only the 40-day-old rows above fall outside the window.
    clearMockNow();
    const refresh = await api.claimNextComputerUseCommand(host.hostToken);
    expect(refresh.status).toBe("idle");

    const third = await api.createComputerUseReadCommand(actor, {
      kind: "app.state",
      app: "Safari",
    });
    await api.claimNextComputerUseCommand(host.hostToken);
    const recentBytes = Buffer.from("bdd-recent-png-bytes");
    await api.completeComputerUseCommandWith(host.hostToken, third.commandId, {
      status: "succeeded",
      result: {
        snapshotId: "snap_bdd_recent",
        screenshot: `data:image/png;base64,${recentBytes.toString("base64")}`,
        screenshotWidth: 800,
        screenshotHeight: 600,
      },
    });
    const thirdKey = `computer-use/${orgId}/${userId}/${third.commandId}/screenshot.png`;

    const invalidCron =
      await api.runComputerUseScreenshotCleanupCron("invalid");
    expect(invalidCron.status).toBe(401);
    expectApiError(invalidCron.body);
    expect(invalidCron.body.error.message).toBe("Invalid cron secret");

    const missingCron =
      await api.runComputerUseScreenshotCleanupCron("missing");
    expect(missingCron.status).toBe(401);

    const swept = await api.runComputerUseScreenshotCleanupCron("valid");
    if (swept.status !== 200) {
      throw new Error("Expected the screenshot cleanup cron to run");
    }
    expect(swept.body.cleaned).toBeGreaterThanOrEqual(2);
    expect(fake.deletedKeys).toContain(firstKey);
    expect(fake.deletedKeys).not.toContain(thirdKey);

    const expiredPointer = await api.readComputerUseCommand(
      actor,
      first.commandId,
    );
    expect(expiredPointer.result?.screenshot).toStrictEqual({
      type: "expired",
    });
    const expiredLegacy = await api.readComputerUseCommand(
      actor,
      second.commandId,
    );
    expect(expiredLegacy.result?.screenshot).toStrictEqual({
      type: "expired",
    });
    const keptRecent = await api.readComputerUseCommand(actor, third.commandId);
    expect(keptRecent.result?.screenshot).toMatchObject({ type: "s3" });

    const resweep = await api.runComputerUseScreenshotCleanupCron("valid");
    if (resweep.status !== 200) {
      throw new Error("Expected the second cleanup sweep to run");
    }
    expect(resweep.body.cleaned).toBe(0);
  });
});
