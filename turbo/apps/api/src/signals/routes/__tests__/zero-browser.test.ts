import { randomUUID } from "node:crypto";

import { cronBrowserReconcileContract } from "@vm0/api-contracts/contracts/cron";
import { zeroBrowserContract } from "@vm0/api-contracts/contracts/zero-browser";
import { zeroUsageRunsContract } from "@vm0/api-contracts/contracts/zero-usage-daily";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { seedUsagePricingRows } from "../../../test-fixtures/system-config-seeds";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const BROWSER_USE_API_URL = "https://api.browser-use.com/api/v3";
const CRON_SECRET = "test-browser-reconcile-secret";
const MINUTE_MS = 60_000;
// The runner job queue expires against the database clock, so this suite pins
// its own clock relative to real time instead of to a fixed calendar date.
const STARTED_AT_MS = now();

function isoAt(offsetMs: number): string {
  return new Date(STARTED_AT_MS + offsetMs).toISOString();
}

function client() {
  return setupApp({ context })(zeroBrowserContract);
}

function cronClient() {
  return setupApp({ context })(cronBrowserReconcileContract);
}

function usageClient() {
  return setupApp({ context })(zeroUsageRunsContract);
}

async function requestBrowserCreate(
  headers: Readonly<Record<string, string>>,
  body: { readonly name: string; readonly maxCredits: number },
): Promise<Response> {
  return await createApp({ signal: context.signal }).request(
    "/api/zero/browsers",
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...body, proxyCountryCode: null }),
    },
  );
}

function providerBrowser(
  id: string,
  args: {
    readonly status?: "active" | "stopped";
    readonly browserCost?: string;
    readonly proxyCost?: string;
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
    // Zero always buys the provider's longest lifetime and reclaims idle
    // browsers itself, so the provider timeout stays far in the future.
    timeoutAt: isoAt(240 * MINUTE_MS),
    startedAt: isoAt(0),
    finishedAt: status === "stopped" ? isoAt(10 * MINUTE_MS) : null,
    proxyUsedMb: args.proxyCost === "0.1" ? "20" : "0",
    proxyCost: args.proxyCost ?? "0",
    browserCost: args.browserCost ?? "0.0003333333333333333333333333333",
    agentSessionId: null,
    recordingUrl: null,
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

function seedBrowserPricing() {
  return seedUsagePricingRows([
    {
      kind: "browser",
      provider: "browser-use",
      category: "provider_cost_usd_micros",
      unitPrice: 1200,
      unitSize: 1_000_000,
    },
  ]);
}

function configureBrowserEnv() {
  mockEnv("ZERO_BROWSER_USE_API_KEY", "test-browser-use-key");
  mockEnv("APP_URL", "https://app.vm0.ai");
  mockEnv("CRON_SECRET", CRON_SECRET);
}

describe("zero browser route", () => {
  afterEach(() => {
    clearMockNow();
  });

  it("shares one profile across concurrent thread browser sessions", async () => {
    mockNow(STARTED_AT_MS);
    configureBrowserEnv();
    await seedBrowserPricing();

    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const chat = createChatFilesBddApi(context);
    const callbacks = createChatCallbacksApi(context);
    const actor = bdd.user({ orgId: STAFF_ORG_ID });
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
    const sent = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Open a managed browser",
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected a chat run");
    }
    const firstClaim = await claimChatRun(runs, actor, sent.body.runId);
    const otherThread = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Use the shared profile from another thread",
      },
      [201],
    );
    if (otherThread.status !== 201 || otherThread.body.runId === null) {
      throw new Error("Expected a second chat thread run");
    }
    const otherThreadClaim = await claimChatRun(
      runs,
      actor,
      otherThread.body.runId,
    );
    async function createCandidate(prompt: string) {
      const sentCandidate = await chat.requestSendMessage(
        actor,
        {
          agentId: agent.agentId,
          prompt,
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

    const profileId = randomUUID();
    const providerIds = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ] as const;
    const providerCreateBodies: unknown[] = [];
    const deletedProfiles: string[] = [];
    const profileCreateStarted = createDeferredPromise<void>(context.signal);
    const releaseProfileCreate = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseProfileCreate.settled()) {
        releaseProfileCreate.resolve(undefined);
      }
    });
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
        profileCreates += 1;
        if (profileCreates > 1) {
          return HttpResponse.json(
            { error: "unexpected profile create" },
            { status: 500 },
          );
        }
        profileCreateStarted.resolve(undefined);
        await releaseProfileCreate.promise;
        return HttpResponse.json(
          {
            id: profileId,
            userId: null,
            name: body.name,
            lastUsedAt: null,
            createdAt: isoAt(0),
            updatedAt: isoAt(0),
            cookieDomains: null,
          },
          { status: 201 },
        );
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
            providerBrowser(String(params.id), {
              status: "stopped",
              browserCost: "0.1",
            }),
          );
        },
      ),
    );

    const firstCreateRequest = client().create({
      headers: firstClaim.browserHeaders,
      body: {
        name: "booking",
        proxyCountryCode: null,
        maxCredits: 150,
      },
    });
    const otherCreateRequest = client().create({
      headers: otherThreadClaim.browserHeaders,
      body: {
        name: "research",
        proxyCountryCode: null,
        maxCredits: 150,
      },
    });
    await profileCreateStarted.promise;
    releaseProfileCreate.resolve(undefined);
    const [created, createdInOtherThread] = await Promise.all([
      accept(firstCreateRequest, [201]),
      accept(otherCreateRequest, [201]),
    ]);
    expect(created.body.browser).toMatchObject({
      name: "booking",
      status: "active",
      maxCredits: 150,
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
    expect(profileCreates).toBe(1);
    expect(providerCreates).toBe(2);
    expect(deletedProfiles).toStrictEqual([]);

    const copiedToAnotherThread = await createApp({
      signal: context.signal,
    }).request(
      `/api/zero/browsers/${created.body.browser.id}?chatThreadId=${randomUUID()}`,
      { headers: firstClaim.browserHeaders },
    );
    expect(copiedToAnotherThread.status).toBe(404);

    const duplicateNew = await requestBrowserCreate(firstClaim.browserHeaders, {
      name: "another",
      maxCredits: 150,
    });
    expect(duplicateNew.status).toBe(409);
    await expect(duplicateNew.json()).resolves.toMatchObject({
      error: { code: "BROWSER_THREAD_ACTIVE" },
    });
    expect(providerCreates).toBe(2);
    expect(profileCreates).toBe(1);
    expect(deletedProfiles).toStrictEqual([]);

    const creditCandidates = await Promise.all([
      createCandidate("Race for the last browser credit reservation A"),
      createCandidate("Race for the last browser credit reservation B"),
    ]);
    const creditAdmissionResults = await Promise.all(
      creditCandidates.map((candidate) => {
        return requestBrowserCreate(candidate.browserHeaders, {
          name: "credit-race",
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

    // Deleting the thread is the only way to make a browser unreachable, so the
    // reconciler treats it as the signal to reclaim the slot immediately.
    await chat.deleteThread(actor, creditWinner.threadId);
    await flushWaitUntilForTest();
    const afterCreditWinnerDeleted = await accept(
      cronClient().reconcile({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    expect(afterCreditWinnerDeleted.body).toMatchObject({
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
    expect(providerCreateBodies).toStrictEqual(
      Array.from({ length: 4 }, () => {
        return {
          profileId,
          proxyCountryCode: null,
          timeout: 240,
          browserScreenWidth: 1440,
          browserScreenHeight: 900,
          allowResizing: false,
          enableRecording: false,
        };
      }),
    );
    expect(profileCreates).toBe(1);
    expect(deletedProfiles).toStrictEqual([]);
  }, 120_000);

  it("keeps the browser live across runs and bills the last run when the idle lease expires", async () => {
    mockNow(STARTED_AT_MS);
    configureBrowserEnv();
    await seedBrowserPricing();

    const bdd = createBddApi(context);
    const routeMocks = createZeroRouteMocks(context);
    const runs = createRunsApi(context);
    const chat = createChatFilesBddApi(context);
    const callbacks = createChatCallbacksApi(context);
    const webhooks = createWebhookCallbackApi(context);
    // A separate organization keeps this test's runs out of the concurrency and
    // browser slots the first test leaves behind.
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
      displayName: "Managed Browser Lease Test",
      visibility: "private",
    });

    const providerIds = [randomUUID(), randomUUID()] as const;
    let providerCreates = 0;
    let providerStops = 0;
    let firstStopFailures = 0;
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, () => {
        return HttpResponse.json(
          {
            id: randomUUID(),
            userId: null,
            name: "vm0-browser-profile",
            lastUsedAt: null,
            createdAt: isoAt(0),
            updatedAt: isoAt(0),
            cookieDomains: null,
          },
          { status: 201 },
        );
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
          if (providerId === providerIds[0] || providerId === providerIds[1]) {
            providerStops += 1;
          }
          return HttpResponse.json(
            providerBrowser(providerId, {
              status: "stopped",
              browserCost: providerId === providerIds[0] ? "0.00333" : "0.1",
              proxyCost: providerId === providerIds[0] ? "0.1" : "0",
            }),
          );
        },
      ),
    );

    const sent = await chat.requestSendMessage(
      actor,
      { agentId: agent.agentId, prompt: "Open a managed browser" },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected a chat run");
    }
    const firstRunId = sent.body.runId;
    const threadId = sent.body.threadId;
    const firstClaim = await claimChatRun(runs, actor, firstRunId);

    const opened = await accept(
      client().use({ headers: firstClaim.browserHeaders, body: {} }),
      [200],
    );
    const browserId = opened.body.browser.id;
    expect(opened.body.browser).toMatchObject({
      status: "active",
      idleExpiresAt: isoAt(10 * MINUTE_MS),
    });
    expect(providerCreates).toBe(1);

    // The run ends without stopping the browser, and the next message is
    // admitted right away instead of waiting for browser cleanup.
    await webhooks.requestAgentComplete(
      { runId: firstRunId, exitCode: 0 },
      firstClaim.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    expect(providerStops).toBe(0);

    await runs.heartbeatRunner(runnerGroup);
    mockNow(STARTED_AT_MS + 5 * MINUTE_MS);
    const followup = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        threadId,
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

    // Before the lease expires the reconciler leaves this browser alone. Other
    // suites' browsers share the reconcile batch, so assert on the healthy
    // instance rather than on the batch totals.
    mockNow(STARTED_AT_MS + 11 * MINUTE_MS);
    const healthy = await accept(
      cronClient().reconcile({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    expect(healthy.body).toMatchObject({ errors: 0, healthy: 1 });
    expect(providerStops).toBe(0);

    mockNow(STARTED_AT_MS + 16 * MINUTE_MS);
    const providerOutage = await accept(
      cronClient().reconcile({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    expect(providerOutage.body).toMatchObject({
      stopped: 0,
      settled: 0,
      errors: 1,
    });
    const reclaimed = await accept(
      cronClient().reconcile({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
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
        query: { chatThreadId: threadId },
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
        query: { runId: firstRunId },
      }),
      [200],
    );
    expect(
      firstRunUsage.body.runs.find((run) => {
        return run.runId === firstRunId;
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

    await chat.deleteThread(actor, threadId);
    await flushWaitUntilForTest();
    const afterThreadDelete = await accept(
      cronClient().reconcile({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    expect(afterThreadDelete.body).toMatchObject({
      stopped: 1,
      settled: 1,
      errors: 0,
    });
    expect(providerStops).toBe(2);

    const settledEverything = await accept(
      cronClient().reconcile({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    expect(settledEverything.body).toMatchObject({
      checked: 0,
      stopped: 0,
      settled: 0,
      errors: 0,
    });
  }, 120_000);
});
