import { randomUUID } from "node:crypto";

import { cronBrowserReconcileContract } from "@vm0/api-contracts/contracts/cron";
import {
  zeroBrowserContract,
  type ZeroBrowserCreateRequest,
} from "@vm0/api-contracts/contracts/zero-browser";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
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
const STARTED_AT_MS = Date.parse("2026-07-24T10:00:00.000Z");

function client() {
  return setupApp({ context })(zeroBrowserContract);
}

function cronClient() {
  return setupApp({ context })(cronBrowserReconcileContract);
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
    timeoutAt: "2026-07-24T11:00:00.000000Z",
    startedAt: "2026-07-24T10:00:00.000000Z",
    finishedAt: status === "stopped" ? "2026-07-24T10:10:00.000000Z" : null,
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

describe("zero browser route", () => {
  afterEach(() => {
    clearMockNow();
  });

  it("shares one profile across concurrent thread browser sessions", async () => {
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
    const firstRunId = sent.body.runId;
    const firstClaim = await claimChatRun(runs, actor, firstRunId);
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
    const otherThreadRunId = otherThread.body.runId;
    const otherThreadClaim = await claimChatRun(runs, actor, otherThreadRunId);
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
        runId: sentCandidate.body.runId,
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
      randomUUID(),
    ] as const;
    const providerCreateBodies: unknown[] = [];
    const deletedProfiles: string[] = [];
    const profileCreateStarted = createDeferredPromise<void>(context.signal);
    const releaseProfileCreate = createDeferredPromise<void>(context.signal);
    const firstStopStarted = createDeferredPromise<void>(context.signal);
    const releaseFirstStop = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseProfileCreate.settled()) {
        releaseProfileCreate.resolve(undefined);
      }
      if (!releaseFirstStop.settled()) {
        releaseFirstStop.resolve(undefined);
      }
    });
    let profileCreates = 0;
    let providerCreates = 0;
    let providerStops = 0;
    let firstProviderStopFailures = 0;
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
            createdAt: "2026-07-24T10:00:00.000000Z",
            updatedAt: "2026-07-24T10:00:00.000000Z",
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
          const providerId = String(params.id);
          if (providerId === firstThreadProviderId) {
            if (!firstStopStarted.settled()) {
              firstStopStarted.resolve(undefined);
            }
            await releaseFirstStop.promise;
            if (firstProviderStopFailures === 0) {
              firstProviderStopFailures += 1;
              return HttpResponse.json(
                { detail: "temporary Browser Use outage" },
                { status: 503 },
              );
            }
          }
          return HttpResponse.json(
            providerId === firstThreadProviderId
              ? providerBrowser(providerId, {
                  status: "stopped",
                  browserCost: "0.00333",
                  proxyCost: "0.1",
                })
              : providerBrowser(providerId, {
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
        timeoutMinutes: 30,
        maxCredits: 150,
      },
    });
    const otherCreateRequest = client().create({
      headers: otherThreadClaim.browserHeaders,
      body: {
        name: "research",
        proxyCountryCode: null,
        timeoutMinutes: 30,
        maxCredits: 150,
      },
    });
    await profileCreateStarted.promise;
    releaseProfileCreate.resolve(undefined);
    const [created, createdInOtherThread] = await Promise.all([
      accept(firstCreateRequest, [201]),
      accept(otherCreateRequest, [201]),
    ]);
    const firstThreadProviderId = z
      .string()
      .uuid()
      .parse(new URL(created.body.cdpUrl).hostname.split(".")[0]);
    expect(created.body.browser).toMatchObject({
      name: "booking",
      status: "active",
      maxCredits: 150,
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

    const duplicateNew = await createApp({
      signal: context.signal,
    }).request("/api/zero/browsers", {
      method: "POST",
      headers: {
        ...firstClaim.browserHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "another",
        proxyCountryCode: null,
        timeoutMinutes: 30,
        maxCredits: 150,
      }),
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
          proxyCountryCode: null,
          timeoutMinutes: 30,
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

    await runs.requestCancelRun(actor, creditWinner.runId, [200]);
    await flushWaitUntilForTest();
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
          timeoutMinutes: 30,
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
    const concurrencyWinnerIndex = concurrencyAdmissionResults.findIndex(
      (result) => {
        return result.status === 201;
      },
    );
    if (concurrencyWinnerIndex === -1) {
      throw new Error("Expected one browser concurrency admission winner");
    }
    const concurrencyWinner = concurrencyCandidates[concurrencyWinnerIndex];
    const concurrencyLoser =
      concurrencyCandidates[concurrencyWinnerIndex === 0 ? 1 : 0];
    if (!concurrencyWinner || !concurrencyLoser) {
      throw new Error("Expected both browser concurrency candidates");
    }
    expect(providerCreates).toBe(4);

    await runs.requestCancelRun(actor, concurrencyWinner.runId, [200]);
    await runs.requestCancelRun(actor, concurrencyLoser.runId, [200]);
    await flushWaitUntilForTest();
    expect(providerStops).toBe(2);

    await webhooks.requestAgentComplete(
      {
        runId: firstRunId,
        exitCode: 1,
        error: "test run finished",
      },
      firstClaim.sandboxHeaders,
      [200],
    );
    await firstStopStarted.promise;

    await runs.heartbeatRunner(runnerGroup);
    const queuedFollowup = await chat.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        threadId: sent.body.threadId,
        prompt: "Continue in the saved browser",
      },
      [201],
    );
    expect(queuedFollowup.body).toMatchObject({ runId: null });

    releaseFirstStop.resolve(undefined);
    await flushWaitUntilForTest();

    const terminalMessages = await chat.listThreadMessages(
      actor,
      sent.body.threadId,
    );
    expect(
      terminalMessages.messages.some((message) => {
        return (
          message.role === "assistant" &&
          message.runId === firstRunId &&
          message.runLifecycleEvent === "failed"
        );
      }),
    ).toBeTruthy();
    const queuedBeforeReconcile = await runs.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    expect(
      queuedBeforeReconcile.runs.some((run) => {
        return run.prompt === "Continue in the saved browser";
      }),
    ).toBeFalsy();

    const recovered = await accept(
      cronClient().reconcile({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    expect(recovered.body).toMatchObject({
      checked: 2,
      stopped: 1,
      settled: 1,
      errors: 0,
      healthy: 1,
    });
    await flushWaitUntilForTest();

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const suspended = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { browserId: created.body.browser.id },
        query: { chatThreadId: sent.body.threadId },
      }),
      [200],
    );
    expect(suspended.body.browser).toMatchObject({
      id: created.body.browser.id,
      status: "suspended",
      grossCredits: 124,
      suspensionReason: "run_end",
    });
    expect(providerStops).toBe(4);

    const runList = await runs.listAgentRuns(actor, {
      status: "queued,pending,running,completed,failed,timeout,cancelled",
      limit: 100,
    });
    const followup = runList.runs.find((run) => {
      return run.prompt === "Continue in the saved browser";
    });
    if (!followup) {
      throw new Error("Expected the queued follow-up to be promoted");
    }
    const followupClaim = await claimChatRun(runs, actor, followup.id);
    const resumed = await accept(
      client().resume({
        headers: followupClaim.browserHeaders,
        body: {},
      }),
      [200],
    );
    expect(resumed.body.browser).toMatchObject({
      id: created.body.browser.id,
      status: "active",
      grossCredits: 124,
    });
    expect(providerCreates).toBe(5);

    const otherStillActive = await accept(
      client().get({
        headers: otherThreadClaim.browserHeaders,
        params: { browserId: createdInOtherThread.body.browser.id },
        query: { chatThreadId: otherThread.body.threadId },
      }),
      [200],
    );
    expect(otherStillActive.body.browser).toMatchObject({
      id: createdInOtherThread.body.browser.id,
      status: "active",
    });

    await webhooks.requestAgentComplete(
      {
        runId: otherThreadRunId,
        exitCode: 0,
      },
      otherThreadClaim.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    expect(providerStops).toBe(5);

    await chat.deleteThread(actor, sent.body.threadId);
    await flushWaitUntilForTest();

    const hiddenAfterThreadDelete = await createApp({
      signal: context.signal,
    }).request(
      `/api/zero/browsers/${created.body.browser.id}?chatThreadId=${sent.body.threadId}`,
      { headers: followupClaim.browserHeaders },
    );
    expect(hiddenAfterThreadDelete.status).toBe(404);

    expect(providerStops).toBe(6);

    const missing = await client().get({
      headers: followupClaim.browserHeaders,
      params: { browserId: created.body.browser.id },
      query: { chatThreadId: sent.body.threadId },
    });
    expect(missing.status).toBe(404);
    expect(providerCreateBodies).toStrictEqual(
      Array.from({ length: 5 }, () => {
        return {
          profileId,
          proxyCountryCode: null,
          timeout: 30,
          browserScreenWidth: 1440,
          browserScreenHeight: 900,
          allowResizing: false,
          enableRecording: false,
        };
      }),
    );

    const reconciled = await accept(
      cronClient().reconcile({
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      [200],
    );
    expect(reconciled.body).toMatchObject({
      checked: 0,
      stopped: 0,
      settled: 0,
      errors: 0,
    });
    expect(providerStops).toBe(6);
  }, 120_000);
});
