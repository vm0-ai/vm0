import { randomUUID } from "node:crypto";

import { cronBrowserReconcileContract } from "@vm0/api-contracts/contracts/cron";
import {
  zeroBrowserAuthorizationRequestsContract,
  zeroBrowserContract,
  type ZeroBrowserCreateRequest,
} from "@vm0/api-contracts/contracts/zero-browser";
import {
  chatThreadComputerUseHostContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createApp } from "../../../app-factory";
import { browserUseCdpHandler } from "../../../__tests__/mocks";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  readBrowserProfileAsPreviousApi,
  setBrowserInstanceAsPreviousApi,
  setComputerUseHostAsPreviousApi,
} from "./helpers/runtime-state";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const computerUse = createComputerUseBddApi(context);
const BROWSER_USE_API_URL = "https://api.browser-use.com/api/v3";
const CRON_SECRET = "test-browser-reconcile-secret";
const STARTED_AT_MS = Date.parse("2026-07-24T10:00:00.000Z");
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

function cronClient() {
  return setupApp({ context })(cronBrowserReconcileContract);
}

async function requestBrowserCreate(
  headers: Readonly<Record<string, string>>,
  // The previous CLI sends maxCredits. The current request schema must keep
  // accepting that extra field throughout the client drain window.
  body: ZeroBrowserCreateRequest & { readonly maxCredits?: number },
): Promise<Response> {
  return await createApp({ signal: context.signal }).request(
    "/api/zero/browsers",
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
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
  afterEach(() => {
    clearMockNow();
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
        query: {},
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
        deletedProfiles.push(String(params.id));
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
      viewerUrl: `https://app.vm0.ai/browsers/${created.body.browser.id}`,
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
    expect(createdInOtherThread.body.browser.id).not.toBe(
      created.body.browser.id,
    );
    expect(profileCreates).toBe(2);
    expect(providerCreates).toBe(2);
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

    if (!actor.orgId) {
      throw new Error("Expected a browser test actor with an organization");
    }
    const actorOrgId = actor.orgId;
    // No current production endpoint can invoke the previous API binary. The
    // guarded compatibility fixture uses only its old profile lookup shape.
    const previousApiRows = await Promise.all(
      [created.body.browser.id, createdInOtherThread.body.browser.id].map(
        async (browserId) => {
          return await readBrowserProfileAsPreviousApi(context, {
            browserId,
            orgId: actorOrgId,
            userId: actor.userId,
          });
        },
      ),
    );
    expect(
      new Set(
        previousApiRows.map((row) => {
          return row.browserProfileId;
        }),
      ).size,
    ).toBe(1);
    expect([...profileIds]).toContain(previousApiRows[0]?.providerProfileId);

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
      client().resizeById({
        headers: { authorization: "Bearer clerk-session" },
        params: { browserId: created.body.browser.id },
        body: { aspectRatio: 0.75 },
      }),
      [200],
    );
    expect(resized.body.browser).toMatchObject({
      id: created.body.browser.id,
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
        params: { browserId: created.body.browser.id },
        query: {},
      }),
      [200],
    );
    expect(restoredForAnotherViewer.body.browser.screen).toStrictEqual({
      width: 1440,
      height: 1920,
      resizable: true,
    });

    await setBrowserInstanceAsPreviousApi(
      context,
      createdInOtherThread.body.browser.id,
    );
    const previousApiBrowser = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { browserId: createdInOtherThread.body.browser.id },
        query: {},
      }),
      [200],
    );
    expect(previousApiBrowser.body.browser.screen).toBeUndefined();
    const unsupportedResize = await createApp({
      signal: context.signal,
    }).request(
      `/api/zero/browsers/${createdInOtherThread.body.browser.id}/resize`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer clerk-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ aspectRatio: 0.75 }),
      },
    );
    expect(unsupportedResize.status).toBe(409);
    await expect(unsupportedResize.json()).resolves.toMatchObject({
      error: { code: "BROWSER_RESIZE_UNSUPPORTED" },
    });
    expect(context.mocks.browserUseCdp.connect).toHaveBeenCalledTimes(1);

    const copiedToAnotherThread = await createApp({
      signal: context.signal,
    }).request(
      `/api/zero/browsers/${created.body.browser.id}?chatThreadId=${randomUUID()}`,
      { headers: first.claim.browserHeaders },
    );
    expect(copiedToAnotherThread.status).toBe(404);

    const duplicateNew = await requestBrowserCreate(
      first.claim.browserHeaders,
      {
        name: "another",
        proxyCountryCode: null,
      },
    );
    expect(duplicateNew.status).toBe(409);
    await expect(duplicateNew.json()).resolves.toMatchObject({
      error: { code: "BROWSER_THREAD_ACTIVE" },
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
        params: { browserId: created.body.browser.id },
        query: { chatThreadId: first.threadId },
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
    const reconciled = await reconcileBrowsers();
    expect(reconciled.body).toMatchObject({
      checked: 0,
      stopped: 0,
      errors: 0,
    });
    expect(deletedProfiles).toStrictEqual([]);
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
    const admitted = await requestBrowserCreate(candidate.browserHeaders, {
      name: "concurrency-replacement",
      proxyCountryCode: null,
      maxCredits: 500,
    });
    expect(admitted.status).toBe(201);
    await expect(admitted.json()).resolves.toMatchObject({
      browser: {
        maxCredits: 1,
        grossCredits: 0,
        creditsCharged: 0,
      },
    });
    await flushWaitUntilForTest();
    expect(providerCreates).toBe(3);
    expect(providerStopAttempts).toStrictEqual([providerIds[0]]);

    const reclaimed = await accept(
      client().get({
        headers: first.claim.browserHeaders,
        params: {
          browserId: (
            await accept(
              client().current({
                headers: first.claim.browserHeaders,
              }),
              [200],
            )
          ).body.browser.id,
        },
        query: { chatThreadId: first.threadId },
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
    const browserId = opened.body.browser.id;
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
        params: { browserId },
        query: { chatThreadId: first.threadId },
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
      id: browserId,
      status: "active",
      idleExpiresAt: isoAt(15 * MINUTE_MS),
    });
    expect(providerCreates).toBe(1);

    const leased = await accept(
      client().lease({ headers: followupClaim.browserHeaders, body: {} }),
      [200],
    );
    expect(leased.body.browser).toMatchObject({
      id: browserId,
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
      { browserId },
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
        params: { browserId },
        query: { chatThreadId: first.threadId },
      }),
      [403],
    );
    expect(agentRead.body.error).toMatchObject({
      code: "BROWSER_AUTHORIZATION_REQUIRED",
    });

    const suspended = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { browserId },
        query: { chatThreadId: first.threadId },
      }),
      [200],
    );
    expect(suspended.body.browser).toMatchObject({
      id: browserId,
      status: "suspended",
      suspensionReason: "idle",
      idleExpiresAt: null,
    });

    // The viewer can restore a reclaimed browser without a live run.
    context.mocks.ably.publish.mockClear();
    const resumed = await accept(
      client().resumeById({
        headers: { authorization: "Bearer clerk-session" },
        params: { browserId },
        body: {},
      }),
      [200],
    );
    expect(resumed.body.browser).toMatchObject({
      id: browserId,
      status: "active",
      idleExpiresAt: isoAt(26 * MINUTE_MS),
    });
    expect(providerCreates).toBe(2);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "browserSessionChanged",
      { browserId },
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
      client().leaseById({
        headers: { authorization: "Bearer clerk-session" },
        params: { browserId },
        body: {},
      }),
      [200],
    );
    expect(viewerLease.body.browser).toMatchObject({
      id: browserId,
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

  it("refuses a viewer action aimed at a browser the thread already replaced", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser",
    );

    const providerIds = [randomUUID(), randomUUID()] as const;
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

    const superseded = await accept(
      client().use({ headers: first.claim.browserHeaders, body: {} }),
      [200],
    );

    // Reclaim the first browser, then open a second one in the same thread so
    // the older card points at a browser that is no longer the current one.
    mockNow(STARTED_AT_MS + 11 * MINUTE_MS);
    const reclaimed = await reconcileBrowsers();
    expect(reclaimed.body).toMatchObject({
      stopped: 1,
      errors: 0,
    });
    await flushWaitUntilForTest();
    expect(providerStops).toBe(1);
    const replacement = await accept(
      client().create({
        headers: first.claim.browserHeaders,
        body: { name: "replacement", proxyCountryCode: null },
      }),
      [201],
    );
    expect(replacement.body.browser.id).not.toBe(superseded.body.browser.id);
    expect(providerCreates).toBe(2);

    // Move the clock so a lease the refused request touched would be visible.
    mockNow(STARTED_AT_MS + 13 * MINUTE_MS);
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const staleResume = await createApp({ signal: context.signal }).request(
      `/api/zero/browsers/${superseded.body.browser.id}/resume`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer clerk-session",
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    expect(staleResume.status).toBe(409);
    await expect(staleResume.json()).resolves.toMatchObject({
      error: { code: "BROWSER_CHANGED" },
    });
    const liveAfterStaleResume = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { browserId: replacement.body.browser.id },
        query: { chatThreadId: first.threadId },
      }),
      [200],
    );
    // The refused request must not have leased or re-owned the live browser.
    expect(liveAfterStaleResume.body.browser.idleExpiresAt).toBe(
      replacement.body.browser.idleExpiresAt,
    );
    expect(providerCreates).toBe(2);

    await chat.deleteThread(actor, first.threadId);
    await flushWaitUntilForTest();
    expect(providerStops).toBe(2);
  }, 120_000);
});
