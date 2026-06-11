import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { clearMockNow, mockNow, now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-helpers";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import {
  createComputerUseBddApi,
  zeroComputerUseToken,
} from "./helpers/api-bdd-computer-use";
import { mockClerkMembership } from "./helpers/api-bdd-github";

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

afterEach(() => {
  clearMockNow();
});

describe("FILE-03 desktop computer-use runtime", () => {
  it("keeps disabled desktop computer-use routes behind the public feature switch", async () => {
    const actor = bdd.user();
    const missingId = randomUUID();

    const hosts = await api.requestListComputerUseHosts(actor, [403]);
    expectApiError(hosts.body);
    expect(hosts.body.error.message).toBe("Computer use is not enabled");

    const startHost = await api.requestStartComputerUseHost(actor, [403]);
    expectApiError(startHost.body);
    expect(startHost.body.error.message).toBe("Computer use is not enabled");

    const deleteHost = await api.requestDeleteComputerUseHost(
      actor,
      missingId,
      [403],
    );
    expectApiError(deleteHost.body);
    expect(deleteHost.body.error.message).toBe("Computer use is not enabled");

    const createCommand = await api.requestCreateComputerUseWriteCommand(
      actor,
      [403],
    );
    expectApiError(createCommand.body);
    expect(createCommand.body.error.message).toBe(
      "Computer use is not enabled",
    );

    const readCommand = await api.requestReadComputerUseCommand(
      actor,
      missingId,
      [403],
    );
    expectApiError(readCommand.body);
    expect(readCommand.body.error.message).toBe("Computer use is not enabled");

    const screenshot = await api.requestComputerUseScreenshot(
      actor,
      missingId,
      [403],
    );
    expectApiError(screenshot.body);
    expect(screenshot.body.error.message).toBe("Computer use is not enabled");

    const approval = await api.decideComputerUseApproval(
      actor,
      missingId,
      { decision: "deny" },
      [403],
    );
    expectApiError(approval.body);
    expect(approval.body.error.message).toBe("Computer use is not enabled");

    const audit = await api.requestListComputerUseAuditEvents(
      actor,
      { commandId: missingId },
      [403],
    );
    expectApiError(audit.body);
    expect(audit.body.error.message).toBe("Computer use is not enabled");
  });

  it("chains host start, command claim, completion, audit, and host deletion", async () => {
    const orgId = `org_${randomUUID()}`;
    const actor = bdd.user({ orgId });
    const peer = bdd.user({ orgId });

    await api.enableComputerUse(actor);
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
    await api.enableComputerUse(actor);
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
    await api.enableComputerUse(actor);

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
      },
    });

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

  it("times out stale running commands and reports completion failures", async () => {
    const actor = bdd.user();
    await api.enableComputerUse(actor);
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

    const notRunning = await api.requestCompleteComputerUseCommand(
      host.hostToken,
      second.commandId,
      { status: "succeeded", result: {} },
      [409],
    );
    expectApiError(notRunning.body);
    expect(notRunning.body.error.message).toBe(
      "Computer-use command is not running",
    );

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
    await api.enableComputerUse(actor);
    await api.enableComputerUse(peer);

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

  it("rejects approval decisions for unknown or non-pending write commands", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const actor = bdd.user({ orgId, userId });
    await api.enableComputerUse(actor);

    const unknown = await api.decideComputerUseApproval(
      actor,
      randomUUID(),
      { decision: "deny" },
      [404],
    );
    expectApiError(unknown.body);
    expect(unknown.body.error.message).toBe(
      "Computer-use write command not found",
    );

    await api.startComputerUseHost(actor);
    const created = await api.createComputerUseWriteCommand(actor);
    expect(created.status).toBe("queued");

    const notPending = await api.decideComputerUseApproval(
      actor,
      created.commandId,
      { decision: "deny", message: "blocked by reviewer" },
      [409],
    );
    expectApiError(notPending.body);
    expect(notPending.body.error.message).toBe(
      "Computer-use write command is not pending approval",
    );

    const zeroCaller = await api.decideComputerUseApproval(
      {
        bearer: zeroComputerUseToken({
          userId,
          orgId,
          capabilities: ["computer-use:write"],
        }).token,
      },
      created.commandId,
      { decision: "approve" },
      [403],
    );
    expectApiError(zeroCaller.body);
    expect(zeroCaller.body.error.message).toBe(
      "This endpoint is not available for sandbox tokens",
    );
  });
});
