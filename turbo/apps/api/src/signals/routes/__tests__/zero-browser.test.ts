import { randomUUID } from "node:crypto";

import { cronBrowserReconcileContract } from "@vm0/api-contracts/contracts/cron";
import {
  zeroBrowserAuthorizationRequestsContract,
  zeroBrowserContract,
} from "@vm0/api-contracts/contracts/zero-browser";
import {
  chatThreadComputerUseHostContract,
  chatThreadEventsContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createApp } from "../../../app-factory";
import { browserUseCdpHandler } from "../../../__tests__/mocks";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now, startNowScopeForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  setBrowserTabSnapshotAsPreviousApi,
  setComputerUseHostAsPreviousApi,
} from "./helpers/runtime-state";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const computerUse = createComputerUseBddApi(context);
const BROWSER_USE_API_URL = "https://api.browser-use.com/api/v3";
const CRON_SECRET = "test-browser-reconcile-secret";
// Keep the mocked application clock aligned with PostgreSQL's wall clock.
// Runner queue claims reject jobs whose application-generated expiry is
// already in the past from the database's perspective.
const STARTED_AT_MS = now();
const MINUTE_MS = 60_000;

function isoAt(offsetMs: number): string {
  return new Date(STARTED_AT_MS + offsetMs).toISOString();
}

function client() {
  return setupApp({ context })(zeroBrowserContract);
}

function authorizationClient() {
  return setupApp({ context })(zeroBrowserAuthorizationRequestsContract);
}

function chatThreadsClient() {
  return setupApp({ context })(chatThreadsContract);
}

function chatThreadComputerUseHostClient() {
  return setupApp({ context })(chatThreadComputerUseHostContract);
}

function chatThreadEventsClient() {
  return setupApp({ context })(chatThreadEventsContract);
}

function cronClient() {
  return setupApp({ context })(cronBrowserReconcileContract);
}

async function requestBrowserUse(
  headers: Readonly<Record<string, string>>,
): Promise<Response> {
  return await createApp({ signal: context.signal }).request(
    "/api/zero/browsers/use",
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );
}

function providerBrowser(
  id: string,
  args: {
    readonly status?: "active" | "stopped";
  } = {},
) {
  const status = args.status ?? "active";
  return {
    id,
    status,
    liveUrl:
      status === "active"
        ? "https://live.browser-use.com/?wss=provider-live-token"
        : null,
    cdpUrl: status === "active" ? `https://${id}.cdp.browser-use.com/` : null,
    // Zero buys the provider's longest lifetime and reclaims idle browsers
    // itself, so the provider deadline stays far away in these tests.
    timeoutAt: isoAt(240 * MINUTE_MS),
    startedAt: isoAt(0),
    finishedAt: status === "stopped" ? isoAt(10 * MINUTE_MS) : null,
    agentSessionId: null,
    recordingUrl: null,
  };
}

function providerProfile(id: string, name: string) {
  return {
    id,
    userId: null,
    name,
    lastUsedAt: null,
    createdAt: isoAt(0),
    updatedAt: isoAt(0),
    cookieDomains: null,
  };
}

async function claimChatRun(
  runs: ReturnType<typeof createRunsApi>,
  actor: ApiTestUser,
  runId: string,
) {
  await flushWaitUntilForTest();
  const claim = await runs.claimRunnerJob(runId);
  const zeroToken = claim.environment?.ZERO_TOKEN;
  if (!zeroToken) {
    throw new Error("Expected the runner claim to include ZERO_TOKEN");
  }
  const browserToken = runs.zeroTokenForRunWithCapabilities(actor, runId, [
    "browser:read",
    "browser:write",
  ]);
  return {
    browserHeaders: { authorization: `Bearer ${browserToken}` },
    sandboxHeaders: {
      authorization: `Bearer ${claim.sandboxToken}`,
    },
  };
}

async function setupBrowserScenario() {
  mockNow(STARTED_AT_MS);
  mockEnv("ZERO_BROWSER_USE_API_KEY", "test-browser-use-key");
  mockEnv("APP_URL", "https://app.vm0.ai");
  mockEnv("CRON_SECRET", CRON_SECRET);
  server.use(
    http.delete(`${BROWSER_USE_API_URL}/profiles/:id`, () => {
      return new HttpResponse(null, { status: 204 });
    }),
  );

  const bdd = createBddApi(context);
  const routeMocks = createZeroRouteMocks(context);
  const runs = createRunsApi(context);
  const chat = createChatFilesBddApi(context);
  const callbacks = createChatCallbacksApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const actor = bdd.user();
  callbacks.acceptChatObjectStorage();
  callbacks.disableVapid();
  callbacks.failIfChatCallbackRouteIsFetched();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.heartbeatRunner(runnerGroup);
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Managed Browser Test",
    visibility: "private",
  });

  return {
    routeMocks,
    runs,
    chat,
    webhooks,
    actor,
    runnerGroup,
    agent,
  };
}

async function createClaimedChatRun(
  chat: ReturnType<typeof createChatFilesBddApi>,
  runs: ReturnType<typeof createRunsApi>,
  actor: ApiTestUser,
  agentId: string,
  prompt: string,
) {
  const sent = await chat.requestSendEvent(
    actor,
    {
      agentId,
      prompt,
      cloudBrowserEnabled: true,
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected a chat run");
  }
  return {
    sent,
    runId: sent.body.runId,
    threadId: sent.body.threadId,
    claim: await claimChatRun(runs, actor, sent.body.runId),
  };
}

async function reconcileBrowsers() {
  return await accept(
    cronClient().reconcile({
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
    [200],
  );
}

describe("zero browser route", () => {
  beforeEach(() => {
    startNowScopeForTest(STARTED_AT_MS);
  });

  it("keeps managed browser access off for a default chat thread", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Try to open a managed browser without enabling it",
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected a chat run");
    }
    const browserToken = runs.zeroTokenForRunWithCapabilities(
      actor,
      sent.body.runId,
      ["browser:read", "browser:write"],
    );

    const rejected = await requestBrowserUse({
      authorization: `Bearer ${browserToken}`,
    });
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      error: {
        code: "BROWSER_AUTHORIZATION_REQUIRED",
        message: "Cloud browser is not enabled for this chat thread",
      },
    });
  });

  it("normalizes a previous API host-only write during cloud browser rollout", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Open a managed browser before selecting this computer",
        cloudBrowserEnabled: true,
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected a chat run");
    }
    const host = await computerUse.startComputerUseHost(actor);

    // The preceding API version knows only computer_use_host_id, so this
    // intentionally omits cloudBrowserEnabled from its update shape.
    await setComputerUseHostAsPreviousApi(context, {
      threadId: sent.body.threadId,
      computerUseHostId: host.hostId,
    });

    const browserToken = runs.zeroTokenForRunWithCapabilities(
      actor,
      sent.body.runId,
      ["browser:read", "browser:write"],
    );
    const rejected = await requestBrowserUse({
      authorization: `Bearer ${browserToken}`,
    });
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      error: {
        code: "BROWSER_AUTHORIZATION_REQUIRED",
        message: "Cloud browser is not enabled for this chat thread",
      },
    });
  });

  it("lets an agent request cloud browser access for its chat thread", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Ask the user to enable a cloud browser",
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected a chat run");
    }
    const runToken = runs.zeroTokenForRunWithCapabilities(
      actor,
      sent.body.runId,
      [],
    );
    const created = await accept(
      authorizationClient().create({
        headers: { authorization: `Bearer ${runToken}` },
        body: {},
      }),
      [200],
    );
    const requestToken = decodeURIComponent(
      new URL(created.body.authorizationUrl).pathname.split("/").at(-1) ?? "",
    );
    expect(requestToken).toMatch(/^vm0_browser_authorization_request_/u);

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const pending = await accept(
      authorizationClient().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken },
      }),
      [200],
    );
    expect(pending.body).toMatchObject({
      completedAt: null,
      cloudBrowserEnabled: false,
    });

    const applied = await accept(
      authorizationClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken },
        body: {},
      }),
      [200],
    );
    expect(applied.body).toStrictEqual({
      ok: true,
      cloudBrowserEnabled: true,
    });

    const events = await accept(
      chatThreadsClient().events({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(events.body.events).toContainEqual(
      expect.objectContaining({
        kind: "computer_use_host_updated",
        chatThreadId: sent.body.threadId,
        computerUseHostId: null,
        cloudBrowserEnabled: true,
      }),
    );
  });

  it("isolates profiles across concurrent thread browser sessions", async () => {
    const { routeMocks, runs, chat, webhooks, actor, agent } =
      await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser",
    );
    const other = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Use a separate profile from another thread",
    );

    const profileIds = [randomUUID(), randomUUID()] as const;
    const providerIds = [randomUUID(), randomUUID()] as const;
    const providerCreateBodies: unknown[] = [];
    const deletedProfiles: string[] = [];
    let profileCreates = 0;
    let providerCreates = 0;
    let providerStops = 0;
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        expect(request.headers.get("x-browser-use-api-key")).toBe(
          "test-browser-use-key",
        );
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        expect(body.name).toMatch(/^vm0-browser-profile-[0-9a-f-]{36}$/u);
        const profileId = profileIds[profileCreates];
        profileCreates += 1;
        if (!profileId) {
          return HttpResponse.json(
            { error: "unexpected profile create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerProfile(profileId, body.name), {
          status: 201,
        });
      }),
      http.delete(`${BROWSER_USE_API_URL}/profiles/:id`, ({ params }) => {
        const profileId = String(params.id);
        deletedProfiles.push(profileId);
        if (
          profileId === profileIds[0] &&
          deletedProfiles.filter((deleted) => {
            return deleted === profileId;
          }).length === 1
        ) {
          return HttpResponse.json(
            { detail: "temporary Browser Use outage" },
            { status: 503 },
          );
        }
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, async ({ request }) => {
        providerCreateBodies.push(await request.json());
        const id = providerIds[providerCreates];
        providerCreates += 1;
        if (!id) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(id), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(
        `${BROWSER_USE_API_URL}/browsers/:id`,
        async ({ params, request }) => {
          await expect(request.json()).resolves.toStrictEqual({
            action: "stop",
          });
          providerStops += 1;
          return HttpResponse.json(
            providerBrowser(String(params.id), { status: "stopped" }),
          );
        },
      ),
    );

    const firstCreateRequest = client().create({
      headers: first.claim.browserHeaders,
      body: {
        name: "booking",
        proxyCountryCode: null,
      },
    });
    const otherCreateRequest = client().create({
      headers: other.claim.browserHeaders,
      body: {
        name: "research",
        proxyCountryCode: null,
      },
    });
    const [created, createdInOtherThread] = await Promise.all([
      accept(firstCreateRequest, [201]),
      accept(otherCreateRequest, [201]),
    ]);
    expect(created.body.browser).toMatchObject({
      name: "booking",
      status: "active",
      // Zero always requests the provider's longest lifetime and manages
      // reclamation through the idle lease instead.
      timeoutMinutes: 240,
      idleExpiresAt: isoAt(10 * MINUTE_MS),
      viewerUrl: `https://app.vm0.ai/browsers/${created.body.browser.threadId}`,
      screen: {
        width: 1440,
        height: 900,
        resizable: true,
      },
    });
    expect(created.body.cdpUrl).toMatch(
      /^https:\/\/[0-9a-f-]{36}\.cdp\.browser-use\.com\/$/u,
    );
    expect(createdInOtherThread.body.browser).toMatchObject({
      name: "research",
      status: "active",
    });
    expect(createdInOtherThread.body.browser.threadId).not.toBe(
      created.body.browser.threadId,
    );
    expect(profileCreates).toBe(2);
    expect(providerCreates).toBe(2);

    const crossThreadResize = await createApp({
      signal: context.signal,
    }).request(
      `/api/zero/chat-threads/${createdInOtherThread.body.browser.threadId}/browser/resize`,
      {
        method: "POST",
        headers: {
          ...first.claim.browserHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({ aspectRatio: 0.75 }),
      },
    );
    expect(crossThreadResize.status).toBe(404);
    await expect(crossThreadResize.json()).resolves.toMatchObject({
      error: { code: "BROWSER_NOT_FOUND" },
    });

    expect(
      providerCreateBodies.map((body) => {
        return z
          .strictObject({
            profileId: z.uuid(),
            proxyCountryCode: z.null(),
            timeout: z.literal(240),
            browserScreenWidth: z.literal(1440),
            browserScreenHeight: z.literal(900),
            allowResizing: z.literal(true),
            enableRecording: z.literal(false),
          })
          .parse(body).profileId;
      }),
    ).toStrictEqual(expect.arrayContaining([...profileIds]));
    expect(deletedProfiles).toStrictEqual([]);

    const createdProviderId = new URL(created.body.cdpUrl).hostname.split(
      ".",
    )[0];
    if (!createdProviderId) {
      throw new Error("Expected a Browser Use provider ID");
    }
    const cdpWebSocketUrl = `wss://${createdProviderId}.cdp.browser-use.com/devtools/browser/test`;
    server.use(
      http.get(
        `https://${createdProviderId}.cdp.browser-use.com/json/version`,
        () => {
          return HttpResponse.json({
            webSocketDebuggerUrl: cdpWebSocketUrl,
          });
        },
      ),
      browserUseCdpHandler(cdpWebSocketUrl),
    );
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const resized = await accept(
      client().resizeByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: created.body.browser.threadId },
        body: { aspectRatio: 0.75 },
      }),
      [200],
    );
    expect(resized.body.browser).toMatchObject({
      threadId: created.body.browser.threadId,
      screen: {
        width: 1440,
        height: 1920,
        resizable: true,
      },
    });
    expect(context.mocks.browserUseCdp.connect).toHaveBeenCalledTimes(1);
    expect(context.mocks.browserUseCdp.connect).toHaveBeenCalledWith(
      cdpWebSocketUrl,
    );
    expect(
      context.mocks.browserUseCdp.command.mock.calls.map(([command]) => {
        return command;
      }),
    ).toStrictEqual([
      { id: 1, method: "Target.getTargets", params: {} },
      {
        id: 2,
        method: "Browser.getWindowForTarget",
        params: { targetId: "page-target" },
      },
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: 7, width: 1440, height: 1920 },
      },
    ]);

    const restoredForAnotherViewer = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: created.body.browser.threadId },
      }),
      [200],
    );
    expect(restoredForAnotherViewer.body.browser.screen).toStrictEqual({
      width: 1440,
      height: 1920,
      resizable: true,
    });
    const copiedToAnotherThread = await createApp({
      signal: context.signal,
    }).request(`/api/zero/chat-threads/${randomUUID()}/browser`, {
      headers: first.claim.browserHeaders,
    });
    expect(copiedToAnotherThread.status).toBe(404);

    const duplicateNew = await accept(
      client().create({
        headers: first.claim.browserHeaders,
        body: {
          name: "another",
          proxyCountryCode: null,
        },
      }),
      [201],
    );
    expect(duplicateNew.body.browser).toMatchObject({
      threadId: created.body.browser.threadId,
      name: "booking",
      status: "active",
    });
    expect(providerCreates).toBe(2);
    expect(profileCreates).toBe(2);
    expect(deletedProfiles).toStrictEqual([]);

    // A terminal run leaves its browser live so the user can keep using it, and
    // restarts the idle lease from the end of the run. The clock moves first so
    // the refreshed deadline cannot be confused with the one create wrote.
    mockNow(STARTED_AT_MS + 2 * MINUTE_MS);
    await webhooks.requestAgentComplete(
      {
        runId: first.runId,
        exitCode: 0,
      },
      first.claim.sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId: other.runId,
        exitCode: 0,
      },
      other.claim.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    expect(providerStops).toBe(0);
    const stillLive = await accept(
      client().get({
        headers: first.claim.browserHeaders,
        params: { threadId: created.body.browser.threadId },
      }),
      [200],
    );
    expect(stillLive.body.browser).toMatchObject({
      status: "active",
      idleExpiresAt: isoAt(12 * MINUTE_MS),
    });

    // Thread deletion releases both local slots and requests provider cleanup
    // without waiting for Browser Use.
    await chat.deleteThread(actor, first.threadId);
    await chat.deleteThread(actor, other.threadId);
    await flushWaitUntilForTest();
    expect(providerStops).toBe(2);
    expect(
      deletedProfiles.filter((profileId) => {
        return profileId === profileIds[0];
      }),
    ).toHaveLength(1);
    expect(
      deletedProfiles.filter((profileId) => {
        return profileId === profileIds[1];
      }),
    ).toHaveLength(1);
    const reconciled = await reconcileBrowsers();
    expect(reconciled.body).toMatchObject({
      checked: 1,
      stopped: 1,
      errors: 0,
    });
    expect(
      deletedProfiles.filter((profileId) => {
        return profileId === profileIds[0];
      }),
    ).toHaveLength(2);
    expect(
      deletedProfiles.filter((profileId) => {
        return profileId === profileIds[1];
      }),
    ).toHaveLength(1);
    const fullyRetired = await reconcileBrowsers();
    expect(fullyRetired.body).toMatchObject({
      checked: 0,
      stopped: 0,
      errors: 0,
    });
  }, 120_000);

  it("reclaims the earliest idle lease before starting past org concurrency", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser",
    );
    const other = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Use the shared profile from another thread",
    );

    // Admission candidates only need a browser-capable run token, so they skip
    // the runner claim that the org's run concurrency limit would throttle.
    async function createCandidate(prompt: string) {
      const sentCandidate = await chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          prompt,
          cloudBrowserEnabled: true,
        },
        [201],
      );
      if (sentCandidate.status !== 201 || sentCandidate.body.runId === null) {
        throw new Error("Expected a browser admission candidate run");
      }
      return {
        threadId: sentCandidate.body.threadId,
        browserHeaders: {
          authorization: `Bearer ${runs.zeroTokenForRunWithCapabilities(
            actor,
            sentCandidate.body.runId,
            ["browser:read", "browser:write"],
          )}`,
        },
      };
    }

    const providerIds = [randomUUID(), randomUUID(), randomUUID()] as const;
    let providerCreates = 0;
    const providerStopAttempts: string[] = [];
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        const id = providerIds[providerCreates];
        providerCreates += 1;
        if (!id) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(id), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        const providerId = String(params.id);
        providerStopAttempts.push(providerId);
        if (providerId === providerIds[0]) {
          return HttpResponse.json(
            { detail: "temporary Browser Use outage" },
            { status: 503 },
          );
        }
        return HttpResponse.json(
          providerBrowser(providerId, { status: "stopped" }),
        );
      }),
    );

    await accept(
      client().create({
        headers: first.claim.browserHeaders,
        body: { name: "booking", proxyCountryCode: null },
      }),
      [201],
    );
    await accept(
      client().create({
        headers: other.claim.browserHeaders,
        body: { name: "research", proxyCountryCode: null },
      }),
      [201],
    );
    expect(providerCreates).toBe(2);

    mockNow(STARTED_AT_MS + MINUTE_MS);
    await accept(
      client().lease({
        headers: other.claim.browserHeaders,
        body: {},
      }),
      [200],
    );
    const candidate = await createCandidate(
      "Start past the managed browser concurrency limit",
    );
    await accept(
      client().create({
        headers: candidate.browserHeaders,
        body: {
          name: "concurrency-replacement",
          proxyCountryCode: null,
        },
      }),
      [201],
    );
    await flushWaitUntilForTest();
    expect(providerCreates).toBe(3);
    expect(providerStopAttempts).toStrictEqual([providerIds[0]]);

    const reclaimed = await accept(
      client().get({
        headers: first.claim.browserHeaders,
        params: {
          threadId: (
            await accept(
              client().current({
                headers: first.claim.browserHeaders,
              }),
              [200],
            )
          ).body.browser.threadId,
        },
      }),
      [200],
    );
    expect(reclaimed.body.browser).toMatchObject({
      status: "suspended",
      suspensionReason: "reconcile",
    });
    const healthy = await reconcileBrowsers();
    expect(healthy.body).toMatchObject({
      checked: 2,
      stopped: 0,
      errors: 0,
      healthy: 2,
    });
    expect(providerStopAttempts).toStrictEqual([providerIds[0]]);

    for (const threadId of [
      first.threadId,
      other.threadId,
      candidate.threadId,
    ]) {
      await chat.deleteThread(actor, threadId);
    }
    await flushWaitUntilForTest();
    expect(providerStopAttempts).toStrictEqual([
      providerIds[0],
      providerIds[1],
      providerIds[2],
    ]);
  }, 120_000);

  it("keeps the browser live across runs, lets its viewer resume, and reclaims its idle lease without retrying provider stop", async () => {
    const { routeMocks, runs, chat, webhooks, actor, runnerGroup, agent } =
      await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser",
    );

    const providerIds = [randomUUID(), randomUUID(), randomUUID()] as const;
    const savedTabUrls = [
      "https://example.com/research?q=one",
      "http://example.org/draft#section",
    ] as const;
    const cdpWebSocketUrls = [
      `wss://${providerIds[0]}.cdp.browser-use.com/devtools/browser/test`,
      `wss://${providerIds[1]}.cdp.browser-use.com/devtools/browser/test`,
    ] as const;
    let currentCdpWebSocketUrl: string | null = null;
    context.mocks.browserUseCdp.connect.mockImplementation((url) => {
      currentCdpWebSocketUrl = url;
    });
    context.mocks.browserUseCdp.command.mockImplementation((command) => {
      if (command.method === "Target.getTargets") {
        if (currentCdpWebSocketUrl === cdpWebSocketUrls[0]) {
          return {
            targetInfos: [
              {
                targetId: "first-tab",
                type: "page",
                url: savedTabUrls[0],
              },
              {
                targetId: "duplicate-first-tab",
                type: "page",
                url: savedTabUrls[0],
              },
              {
                targetId: "second-tab",
                type: "page",
                url: savedTabUrls[1],
              },
              {
                targetId: "internal-tab",
                type: "page",
                url: "chrome://settings/",
              },
              {
                targetId: "embedded-page",
                type: "iframe",
                url: "https://example.net/embedded",
              },
            ],
          };
        }
        return {
          targetInfos: [
            {
              targetId: "default-tab",
              type: "page",
              url: "about:blank",
            },
          ],
        };
      }
      if (
        currentCdpWebSocketUrl === cdpWebSocketUrls[1] &&
        command.method === "Target.createTarget" &&
        command.params.url === savedTabUrls[0]
      ) {
        return new Error("test tab restoration failure");
      }
      return undefined;
    });
    let providerCreates = 0;
    let providerStops = 0;
    let firstStopFailures = 0;
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        const id = providerIds[providerCreates];
        providerCreates += 1;
        if (!id) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(id), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.get(
        `https://${providerIds[0]}.cdp.browser-use.com/json/version`,
        () => {
          return HttpResponse.json({
            webSocketDebuggerUrl: cdpWebSocketUrls[0],
          });
        },
      ),
      http.get(
        `https://${providerIds[1]}.cdp.browser-use.com/json/version`,
        () => {
          return HttpResponse.json({
            webSocketDebuggerUrl: cdpWebSocketUrls[1],
          });
        },
      ),
      browserUseCdpHandler(cdpWebSocketUrls[0]),
      browserUseCdpHandler(cdpWebSocketUrls[1]),
      http.patch(
        `${BROWSER_USE_API_URL}/browsers/:id`,
        async ({ params, request }) => {
          await expect(request.json()).resolves.toStrictEqual({
            action: "stop",
          });
          const providerId = String(params.id);
          if (providerId === providerIds[0] && firstStopFailures === 0) {
            firstStopFailures += 1;
            return HttpResponse.json(
              { detail: "temporary Browser Use outage" },
              { status: 503 },
            );
          }
          providerStops += 1;
          return HttpResponse.json(
            providerBrowser(providerId, { status: "stopped" }),
          );
        },
      ),
    );

    const opened = await accept(
      client().use({ headers: first.claim.browserHeaders, body: {} }),
      [200],
    );
    const threadId = opened.body.browser.threadId;
    expect(opened.body.browser).toMatchObject({
      status: "active",
      idleExpiresAt: isoAt(10 * MINUTE_MS),
    });
    expect(providerCreates).toBe(1);

    // The run ends without stopping the browser, and the thread's next message
    // starts a run right away instead of waiting for browser cleanup.
    mockNow(STARTED_AT_MS + 3 * MINUTE_MS);
    await webhooks.requestAgentComplete(
      { runId: first.runId, exitCode: 0 },
      first.claim.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    expect(providerStops).toBe(0);
    const released = await accept(
      client().get({
        headers: first.claim.browserHeaders,
        params: { threadId },
      }),
      [200],
    );
    expect(released.body.browser).toMatchObject({
      status: "active",
      idleExpiresAt: isoAt(13 * MINUTE_MS),
    });

    await runs.heartbeatRunner(runnerGroup);
    mockNow(STARTED_AT_MS + 5 * MINUTE_MS);
    const followup = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        threadId: first.threadId,
        prompt: "Continue in the same browser",
      },
      [201],
    );
    if (followup.status !== 201 || followup.body.runId === null) {
      throw new Error("Expected the follow-up message to start a run");
    }
    const followupRunId = followup.body.runId;
    const followupClaim = await claimChatRun(runs, actor, followupRunId);

    // The next run attaches to the very same provider instance.
    const reused = await accept(
      client().use({ headers: followupClaim.browserHeaders, body: {} }),
      [200],
    );
    expect(reused.body.browser).toMatchObject({
      threadId: threadId,
      status: "active",
      idleExpiresAt: isoAt(15 * MINUTE_MS),
    });
    expect(providerCreates).toBe(1);

    const leased = await accept(
      client().lease({ headers: followupClaim.browserHeaders, body: {} }),
      [200],
    );
    expect(leased.body.browser).toMatchObject({
      threadId: threadId,
      idleExpiresAt: isoAt(15 * MINUTE_MS),
    });

    // Before the lease expires the reconciler leaves the browser alone.
    mockNow(STARTED_AT_MS + 11 * MINUTE_MS);
    const healthy = await reconcileBrowsers();
    expect(healthy.body).toMatchObject({
      checked: 1,
      stopped: 0,
      errors: 0,
      healthy: 1,
    });
    expect(providerStops).toBe(0);

    mockNow(STARTED_AT_MS + 16 * MINUTE_MS);
    context.mocks.ably.publish.mockClear();
    const reclaimed = await reconcileBrowsers();
    expect(reclaimed.body).toMatchObject({
      stopped: 1,
      errors: 0,
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "browserSessionChanged",
      { threadId },
    );
    await flushWaitUntilForTest();
    expect(firstStopFailures).toBe(1);
    expect(providerStops).toBe(0);
    const afterFailedStop = await reconcileBrowsers();
    expect(afterFailedStop.body).toMatchObject({
      checked: 0,
      stopped: 0,
      errors: 0,
    });
    expect(firstStopFailures).toBe(1);

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    await accept(
      chatThreadComputerUseHostClient().update({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: first.threadId },
        body: {
          computerUseHostId: null,
          cloudBrowserEnabled: false,
        },
      }),
      [204],
    );

    const agentRead = await accept(
      client().get({
        headers: followupClaim.browserHeaders,
        params: { threadId },
      }),
      [403],
    );
    expect(agentRead.body.error).toMatchObject({
      code: "BROWSER_AUTHORIZATION_REQUIRED",
    });

    const suspended = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId },
      }),
      [200],
    );
    expect(suspended.body.browser).toMatchObject({
      threadId: threadId,
      status: "suspended",
      suspensionReason: "idle",
      idleExpiresAt: null,
    });

    // The viewer can restore a reclaimed browser without a live run.
    context.mocks.ably.publish.mockClear();
    const resumed = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId },
        body: { eventId: randomUUID() },
      }),
      [200],
    );
    expect(resumed.body.browser).toMatchObject({
      threadId: threadId,
      status: "active",
      idleExpiresAt: isoAt(26 * MINUTE_MS),
    });
    expect(providerCreates).toBe(2);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "browserSessionChanged",
      { threadId },
    );
    expect(context.mocks.browserUseCdp.connect.mock.calls).toStrictEqual([
      [cdpWebSocketUrls[0]],
      [cdpWebSocketUrls[1]],
    ]);
    expect(
      context.mocks.browserUseCdp.command.mock.calls.map(([command]) => {
        return command;
      }),
    ).toStrictEqual([
      { id: 1, method: "Target.getTargets", params: {} },
      { id: 1, method: "Target.getTargets", params: {} },
      {
        id: 2,
        method: "Target.createTarget",
        params: { url: savedTabUrls[0] },
      },
      {
        id: 3,
        method: "Target.createTarget",
        params: { url: savedTabUrls[1] },
      },
      {
        id: 4,
        method: "Target.closeTarget",
        params: { targetId: "default-tab" },
      },
    ]);

    mockNow(STARTED_AT_MS + 20 * MINUTE_MS);
    const viewerLease = await accept(
      client().leaseByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId },
        body: {},
      }),
      [200],
    );
    expect(viewerLease.body.browser).toMatchObject({
      threadId: threadId,
      idleExpiresAt: isoAt(30 * MINUTE_MS),
    });

    await chat.deleteThread(actor, first.threadId);
    await flushWaitUntilForTest();
    expect(providerStops).toBe(1);

    const reconciled = await reconcileBrowsers();
    expect(reconciled.body).toMatchObject({
      checked: 0,
      stopped: 0,
      errors: 0,
    });
  }, 120_000);

  it("deduplicates previous snapshot URLs before restoring browser tabs", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Restore a managed browser snapshot",
    );

    const providerIds = [randomUUID(), randomUUID()] as const;
    const savedTabUrls = [
      "https://example.com/research?q=one",
      "http://example.org/draft#section",
    ] as const;
    const cdpWebSocketUrls = [
      `wss://${providerIds[0]}.cdp.browser-use.com/devtools/browser/test`,
      `wss://${providerIds[1]}.cdp.browser-use.com/devtools/browser/test`,
    ] as const;
    let currentCdpWebSocketUrl: string | null = null;
    context.mocks.browserUseCdp.connect.mockImplementation((url) => {
      currentCdpWebSocketUrl = url;
    });
    context.mocks.browserUseCdp.command.mockImplementation((command) => {
      if (command.method !== "Target.getTargets") {
        return undefined;
      }
      if (currentCdpWebSocketUrl === cdpWebSocketUrls[0]) {
        return {
          targetInfos: [
            {
              targetId: "captured-tab",
              type: "page",
              url: savedTabUrls[0],
            },
          ],
        };
      }
      return {
        targetInfos: [
          {
            targetId: "default-tab",
            type: "page",
            url: "about:blank",
          },
        ],
      };
    });
    let providerCreates = 0;
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        const providerId = providerIds[providerCreates];
        providerCreates += 1;
        if (!providerId) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(providerId), {
          status: 201,
        });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      ...providerIds.map((providerId, index) => {
        const webSocketUrl = cdpWebSocketUrls[index];
        return http.get(
          `https://${providerId}.cdp.browser-use.com/json/version`,
          () => {
            return HttpResponse.json({
              webSocketDebuggerUrl: webSocketUrl,
            });
          },
        );
      }),
      ...cdpWebSocketUrls.map((webSocketUrl) => {
        return browserUseCdpHandler(webSocketUrl);
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(
          providerBrowser(String(params.id), { status: "stopped" }),
        );
      }),
    );

    const opened = await accept(
      client().use({ headers: first.claim.browserHeaders, body: {} }),
      [200],
    );
    const threadId = opened.body.browser.threadId;
    mockNow(STARTED_AT_MS + 11 * MINUTE_MS);
    const reclaimed = await reconcileBrowsers();
    expect(reclaimed.body).toMatchObject({ stopped: 1, errors: 0 });
    await flushWaitUntilForTest();

    // This historical snapshot shape cannot be produced through the current
    // capture path because capture now deduplicates before persistence.
    await setBrowserTabSnapshotAsPreviousApi(context, {
      threadId,
      tabUrls: [
        savedTabUrls[0],
        savedTabUrls[0],
        savedTabUrls[1],
        savedTabUrls[0],
        savedTabUrls[1],
      ],
    });
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const resumed = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId },
        body: { eventId: randomUUID() },
      }),
      [200],
    );
    expect(resumed.body.browser.status).toBe("active");
    expect(
      context.mocks.browserUseCdp.command.mock.calls
        .map(([command]) => {
          return command;
        })
        .filter((command) => {
          return command.method === "Target.createTarget";
        }),
    ).toStrictEqual([
      {
        id: 2,
        method: "Target.createTarget",
        params: { url: savedTabUrls[0] },
      },
      {
        id: 3,
        method: "Target.createTarget",
        params: { url: savedTabUrls[1] },
      },
    ]);

    await chat.deleteThread(actor, first.threadId);
    await flushWaitUntilForTest();
  }, 120_000);

  it("reuses one thread browser and records start-stop lifecycle events", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser",
    );

    const providerIds = [randomUUID(), randomUUID(), randomUUID()] as const;
    let providerCreates = 0;
    let providerStops = 0;
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        const id = providerIds[providerCreates];
        providerCreates += 1;
        if (!id) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(id), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        providerStops += 1;
        return HttpResponse.json(
          providerBrowser(String(params.id), { status: "stopped" }),
        );
      }),
    );

    const firstStart = await accept(
      client().use({ headers: first.claim.browserHeaders, body: {} }),
      [200],
    );

    mockNow(STARTED_AT_MS + 11 * MINUTE_MS);
    const reclaimed = await reconcileBrowsers();
    expect(reclaimed.body).toMatchObject({
      stopped: 1,
      errors: 0,
    });
    await flushWaitUntilForTest();
    expect(providerStops).toBe(1);
    const resumed = await accept(
      client().create({
        headers: first.claim.browserHeaders,
        body: { name: "replacement", proxyCountryCode: null },
      }),
      [201],
    );
    expect(resumed.body.browser).toMatchObject({
      threadId: firstStart.body.browser.threadId,
      status: "active",
    });
    expect(providerCreates).toBe(2);

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const noOpEventId = randomUUID();
    const alreadyActive = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: first.threadId },
        body: { eventId: noOpEventId },
      }),
      [200],
    );
    expect(alreadyActive.body).toMatchObject({
      lifecycleEventId: null,
      browser: { threadId: first.threadId, status: "active" },
    });

    const stopEventId = randomUUID();
    const stopped = await accept(
      client().stop({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: first.threadId },
        body: { eventId: stopEventId },
      }),
      [200],
    );
    expect(stopped.body).toMatchObject({
      lifecycleEventId: stopEventId,
      browser: {
        threadId: first.threadId,
        status: "suspended",
        suspensionReason: "user",
      },
    });
    await flushWaitUntilForTest();
    expect(providerStops).toBe(2);

    const events = await accept(
      chatThreadEventsClient().list({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: first.threadId },
        query: { limit: 50 },
      }),
      [200],
    );
    expect(
      events.body.events.flatMap((event) => {
        return event.eventType === "browser.started" ||
          event.eventType === "browser.stopped"
          ? [
              {
                id: event.id,
                eventType: event.eventType,
                content: event.content,
              },
            ]
          : [];
      }),
    ).toStrictEqual([
      {
        id: firstStart.body.lifecycleEventId,
        eventType: "browser.started",
        content: null,
      },
      expect.objectContaining({
        eventType: "browser.stopped",
        content: null,
      }),
      {
        id: resumed.body.lifecycleEventId,
        eventType: "browser.started",
        content: null,
      },
      {
        id: stopEventId,
        eventType: "browser.stopped",
        content: null,
      },
    ]);
    expect(
      events.body.events.some((event) => {
        return event.id === noOpEventId;
      }),
    ).toBeFalsy();

    const collided = await createApp({
      signal: context.signal,
    }).request(`/api/zero/chat-threads/${first.threadId}/browser/start`, {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ eventId: stopEventId }),
    });
    expect(collided.status).toBe(409);
    await expect(collided.json()).resolves.toMatchObject({
      error: { code: "BROWSER_EVENT_ID_CONFLICT" },
    });
    expect(providerCreates).toBe(3);
    await flushWaitUntilForTest();
    expect(providerStops).toBe(3);

    await chat.deleteThread(actor, first.threadId);
    await flushWaitUntilForTest();
    expect(providerStops).toBe(3);
  }, 120_000);
});
