import { randomUUID } from "node:crypto";

import { cronBrowserReconcileContract } from "@vm0/api-contracts/contracts/cron";
import {
  zeroBrowserAuthorizationRequestsContract,
  zeroBrowserContract,
  type ZeroBrowserCreateRequest,
} from "@vm0/api-contracts/contracts/zero-browser";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroUsageRunsContract } from "@vm0/api-contracts/contracts/zero-usage-daily";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { seedUsagePricingRows } from "../../../test-fixtures/system-config-seeds";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  readBrowserProfileAsPreviousApi,
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

function cronClient() {
  return setupApp({ context })(cronBrowserReconcileContract);
}

function usageClient() {
  return setupApp({ context })(zeroUsageRunsContract);
}

async function requestBrowserCreate(
  headers: Readonly<Record<string, string>>,
  body: ZeroBrowserCreateRequest,
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
    readonly browserCost?: string;
    readonly proxyCost?: string;
    readonly proxyUsedMb?: string;
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
    // These defaults mirror Browser Use v3 active and stopped responses.
    proxyUsedMb:
      args.proxyUsedMb ??
      (status === "active" ? "0" : "4.98114681243896440625"),
    proxyCost:
      args.proxyCost ??
      (status === "active" ? "0" : "0.000972880236804485235595703125"),
    browserCost:
      args.browserCost ??
      (status === "active"
        ? "0.001666666666666666666666666666"
        : "0.005333333333333333333333333333"),
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
  await seedUsagePricingRows([
    {
      kind: "browser",
      provider: "browser-use",
      category: "provider_cost_usd_micros",
      unitPrice: 1200,
      unitSize: 1_000_000,
    },
  ]);

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
  const sent = await chat.requestSendMessage(
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
    const sent = await chat.requestSendMessage(
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
    const sent = await chat.requestSendMessage(
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
    const sent = await chat.requestSendMessage(
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
    const { runs, chat, webhooks, actor, agent } = await setupBrowserScenario();
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
        maxCredits: 150,
      },
    });
    const otherCreateRequest = client().create({
      headers: other.claim.browserHeaders,
      body: {
        name: "research",
        proxyCountryCode: null,
        maxCredits: 150,
      },
    });
    const [created, createdInOtherThread] = await Promise.all([
      accept(firstCreateRequest, [201]),
      accept(otherCreateRequest, [201]),
    ]);
    expect(created.body.browser).toMatchObject({
      name: "booking",
      status: "active",
      maxCredits: 150,
      // Zero always requests the provider's longest lifetime and manages
      // reclamation through the idle lease instead.
      timeoutMinutes: 240,
      idleExpiresAt: isoAt(10 * MINUTE_MS),
      viewerUrl: `https://app.vm0.ai/browsers/${created.body.browser.id}`,
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
            allowResizing: z.literal(false),
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
        maxCredits: 150,
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

    // Nobody can reach a deleted thread's browser, so the reconciler reclaims
    // both of them without waiting for their leases.
    await chat.deleteThread(actor, first.threadId);
    await chat.deleteThread(actor, other.threadId);
    await flushWaitUntilForTest();
    const reclaimed = await reconcileBrowsers();
    expect(reclaimed.body).toMatchObject({
      checked: 2,
      stopped: 2,
      settled: 2,
      errors: 0,
    });
    expect(providerStops).toBe(2);
    expect(deletedProfiles).toStrictEqual([]);
  }, 120_000);

  it("rejects browser admission past the credit and concurrency limits", async () => {
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
      const sentCandidate = await chat.requestSendMessage(
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

    const providerIds = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ] as const;
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

    await accept(
      client().create({
        headers: first.claim.browserHeaders,
        body: { name: "booking", proxyCountryCode: null, maxCredits: 150 },
      }),
      [201],
    );
    await accept(
      client().create({
        headers: other.claim.browserHeaders,
        body: { name: "research", proxyCountryCode: null, maxCredits: 150 },
      }),
      [201],
    );
    expect(providerCreates).toBe(2);

    const creditCandidates = await Promise.all([
      createCandidate("Race for the last browser credit reservation A"),
      createCandidate("Race for the last browser credit reservation B"),
    ]);
    const creditAdmissionResults = await Promise.all(
      creditCandidates.map((candidate) => {
        return requestBrowserCreate(candidate.browserHeaders, {
          name: "credit-race",
          proxyCountryCode: null,
          maxCredits: 19_700,
        });
      }),
    );
    expect(
      creditAdmissionResults
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([201, 402]);
    const creditRejection = creditAdmissionResults.find((result) => {
      return result.status === 402;
    });
    if (!creditRejection) {
      throw new Error("Expected one browser credit admission rejection");
    }
    await expect(creditRejection.json()).resolves.toMatchObject({
      error: { code: "INSUFFICIENT_CREDITS" },
    });
    const creditWinnerIndex = creditAdmissionResults.findIndex((result) => {
      return result.status === 201;
    });
    if (creditWinnerIndex === -1) {
      throw new Error("Expected one browser credit admission winner");
    }
    const creditWinner = creditCandidates[creditWinnerIndex];
    const creditLoser = creditCandidates[creditWinnerIndex === 0 ? 1 : 0];
    if (!creditWinner || !creditLoser) {
      throw new Error("Expected both browser credit admission candidates");
    }
    expect(providerCreates).toBe(3);

    // Ending a run no longer frees its browser slot. Deleting the thread does,
    // once the reconciler has settled the instance.
    await chat.deleteThread(actor, creditWinner.threadId);
    await flushWaitUntilForTest();
    const freedSlot = await reconcileBrowsers();
    expect(freedSlot.body).toMatchObject({
      stopped: 1,
      settled: 1,
      errors: 0,
    });
    expect(providerStops).toBe(1);

    const concurrencyCandidate = await createCandidate(
      "Race for the last browser concurrency slot",
    );
    const concurrencyCandidates = [creditLoser, concurrencyCandidate] as const;
    const concurrencyAdmissionResults = await Promise.all(
      concurrencyCandidates.map((candidate) => {
        return requestBrowserCreate(candidate.browserHeaders, {
          name: "concurrency-race",
          proxyCountryCode: null,
          maxCredits: 100,
        });
      }),
    );
    expect(
      concurrencyAdmissionResults
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([201, 409]);
    const concurrencyRejection = concurrencyAdmissionResults.find((result) => {
      return result.status === 409;
    });
    if (!concurrencyRejection) {
      throw new Error("Expected one browser concurrency admission rejection");
    }
    await expect(concurrencyRejection.json()).resolves.toMatchObject({
      error: { code: "BROWSER_CONCURRENCY_LIMIT" },
    });
    expect(providerCreates).toBe(4);

    // The reconciler is global, so leave nothing unsettled for other tests.
    for (const threadId of [
      first.threadId,
      other.threadId,
      creditLoser.threadId,
      concurrencyCandidate.threadId,
    ]) {
      await chat.deleteThread(actor, threadId);
    }
    await flushWaitUntilForTest();
    await reconcileBrowsers();
    expect(providerStops).toBe(4);
  }, 120_000);

  it("keeps the browser live across runs and bills the last run when the idle lease expires", async () => {
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
            providerBrowser(providerId, {
              status: "stopped",
              browserCost: providerId === providerIds[0] ? "+0.00333" : "0.1",
              proxyCost: providerId === providerIds[0] ? ".1" : "0.",
              proxyUsedMb: providerId === providerIds[0] ? "20" : "0",
            }),
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
    const followup = await chat.requestSendMessage(
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
      settled: 0,
      errors: 0,
      healthy: 1,
    });
    expect(providerStops).toBe(0);

    mockNow(STARTED_AT_MS + 16 * MINUTE_MS);
    const providerOutage = await reconcileBrowsers();
    expect(providerOutage.body).toMatchObject({
      stopped: 0,
      settled: 0,
      errors: 1,
    });
    const reclaimed = await reconcileBrowsers();
    expect(reclaimed.body).toMatchObject({
      stopped: 1,
      settled: 1,
      errors: 0,
    });
    expect(providerStops).toBe(1);
    await flushWaitUntilForTest();

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
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
      grossCredits: 124,
      idleExpiresAt: null,
    });

    // The whole instance is billed to the run that last used it, not to the run
    // that opened it.
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        {
          id: actor.userId,
          primaryEmailAddressId: `email_${actor.userId}`,
          emailAddresses: [
            {
              id: `email_${actor.userId}`,
              emailAddress: `${actor.userId}@example.com`,
            },
          ],
        },
      ],
    });
    const followupUsage = await accept(
      usageClient().get({
        headers: { authorization: "Bearer clerk-session" },
        query: { runId: followupRunId },
      }),
      [200],
    );
    expect(followupUsage.body.runs[0]).toMatchObject({
      runId: followupRunId,
      creditsCharged: 124,
    });
    const firstRunUsage = await accept(
      usageClient().get({
        headers: { authorization: "Bearer clerk-session" },
        query: { runId: first.runId },
      }),
      [200],
    );
    expect(
      firstRunUsage.body.runs.find((run) => {
        return run.runId === first.runId;
      })?.creditsCharged ?? 0,
    ).toBe(0);

    // The viewer can restore a reclaimed browser without a live run.
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
      grossCredits: 124,
      idleExpiresAt: isoAt(26 * MINUTE_MS),
    });
    expect(providerCreates).toBe(2);

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
    const afterThreadDelete = await reconcileBrowsers();
    expect(afterThreadDelete.body).toMatchObject({
      stopped: 1,
      settled: 1,
      errors: 0,
    });
    expect(providerStops).toBe(2);

    const settledEverything = await reconcileBrowsers();
    expect(settledEverything.body).toMatchObject({
      checked: 0,
      stopped: 0,
      settled: 0,
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
        return HttpResponse.json({
          id: String(params.id),
          status: "stopped",
          timeoutAt: isoAt(240 * MINUTE_MS),
          startedAt: isoAt(0),
          proxyUsedMb: null,
          proxyCost: null,
          browserCost: null,
        });
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
      settled: 1,
      errors: 0,
    });
    expect(providerStops).toBe(1);
    const replacement = await accept(
      client().create({
        headers: first.claim.browserHeaders,
        body: { name: "replacement", proxyCountryCode: null, maxCredits: 100 },
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
    await reconcileBrowsers();
    expect(providerStops).toBe(2);
  }, 120_000);
});
