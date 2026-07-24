import { randomUUID } from "node:crypto";

import { cronBrowserReconcileContract } from "@vm0/api-contracts/contracts/cron";
import { zeroBrowserContract } from "@vm0/api-contracts/contracts/zero-browser";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { seedUsagePricingRows } from "../../../test-fixtures/system-config-seeds";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronBrowserReconcileRoutes } from "../cron-browser-reconcile";
import { zeroBrowserRoutes } from "../zero-browser";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const BROWSER_USE_API_URL = "https://api.browser-use.com/api/v3";
const CRON_SECRET = "test-browser-reconcile-secret";
const STARTED_AT_MS = Date.parse("2026-07-24T10:00:00.000Z");

function client() {
  return setupAppWithRoutes({ context, routes: zeroBrowserRoutes })(
    zeroBrowserContract,
  );
}

function cronClient() {
  return setupAppWithRoutes({
    context,
    routes: cronBrowserReconcileRoutes,
  })(cronBrowserReconcileContract);
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
    timeoutAt: "2026-07-24T11:00:00.000Z",
    startedAt: "2026-07-24T10:00:00.000Z",
    liveUrl:
      status === "active"
        ? "https://live.browser-use.com/?wss=provider-live-token"
        : null,
    cdpUrl:
      status === "active"
        ? "wss://connect.browser-use.com/?token=provider-cdp-token"
        : null,
    finishedAt: status === "stopped" ? "2026-07-24T10:10:00.000Z" : null,
    proxyUsedMb: args.proxyCost === "0.1" ? "20" : "0",
    proxyCost: args.proxyCost ?? "0",
    browserCost: args.browserCost ?? "0",
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

  it("shares one profile across threads while serializing provider sessions", async () => {
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

    const profileId = randomUUID();
    const providerIds = [randomUUID(), randomUUID(), randomUUID()] as const;
    const providerCreateBodies: unknown[] = [];
    const deletedProfiles: string[] = [];
    const firstStopStarted = createDeferredPromise<void>(context.signal);
    const releaseFirstStop = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseFirstStop.settled()) {
        releaseFirstStop.resolve(undefined);
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
        const body = await request.json();
        expect(body).toMatchObject({
          name: expect.stringMatching(/^vm0-browser-profile-[0-9a-f-]{36}$/u),
        });
        const id = profileCreates === 0 ? profileId : undefined;
        profileCreates += 1;
        if (!id) {
          return HttpResponse.json(
            { error: "unexpected profile create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(
          {
            id,
            createdAt: "2026-07-24T10:00:00.000Z",
            updatedAt: "2026-07-24T10:00:00.000Z",
            userId: "test-user",
            name: "test-profile",
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
          if (providerId === providerIds[0]) {
            if (!firstStopStarted.settled()) {
              firstStopStarted.resolve(undefined);
            }
            await releaseFirstStop.promise;
          }
          return HttpResponse.json(
            providerId === providerIds[0]
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

    const created = await accept(
      client().create({
        headers: firstClaim.browserHeaders,
        body: {
          name: "booking",
          proxyCountryCode: null,
          timeoutMinutes: 30,
          maxCredits: 150,
        },
      }),
      [201],
    );
    expect(created.body.browser).toMatchObject({
      name: "booking",
      status: "active",
      maxCredits: 150,
      viewerUrl: `https://app.vm0.ai/browsers/${created.body.browser.id}`,
    });
    expect(created.body.cdpUrl).toContain("provider-cdp-token");

    const copiedToAnotherThread = await createAppWithRoutes({
      signal: context.signal,
      routes: zeroBrowserRoutes,
    }).request(
      `/api/zero/browsers/${created.body.browser.id}?chatThreadId=${randomUUID()}`,
      { headers: firstClaim.browserHeaders },
    );
    expect(copiedToAnotherThread.status).toBe(404);

    const duplicateNew = await createAppWithRoutes({
      signal: context.signal,
      routes: zeroBrowserRoutes,
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
    expect(providerCreates).toBe(1);
    expect(profileCreates).toBe(1);
    expect(deletedProfiles).toStrictEqual([]);

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

    const busyAcrossThreads = await accept(
      client().create({
        headers: otherThreadClaim.browserHeaders,
        body: {
          name: "research",
          proxyCountryCode: null,
          timeoutMinutes: 30,
          maxCredits: 150,
        },
      }),
      [409],
    );
    expect(busyAcrossThreads.body.error).toMatchObject({
      code: "BROWSER_PROFILE_BUSY",
    });
    expect(providerCreates).toBe(1);

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

    const suspended = await accept(
      client().get({
        headers: firstClaim.browserHeaders,
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
    expect(providerStops).toBe(1);

    const createdInOtherThread = await accept(
      client().create({
        headers: otherThreadClaim.browserHeaders,
        body: {
          name: "research",
          proxyCountryCode: null,
          timeoutMinutes: 30,
          maxCredits: 150,
        },
      }),
      [201],
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
    const blockedResume = await accept(
      client().resume({
        headers: followupClaim.browserHeaders,
        body: {},
      }),
      [409],
    );
    expect(blockedResume.body.error).toMatchObject({
      code: "BROWSER_PROFILE_BUSY",
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
    expect(providerStops).toBe(2);

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
    expect(providerCreates).toBe(3);

    await chat.deleteThread(actor, sent.body.threadId);
    await flushWaitUntilForTest();

    const hiddenAfterThreadDelete = await createAppWithRoutes({
      signal: context.signal,
      routes: zeroBrowserRoutes,
    }).request(
      `/api/zero/browsers/${created.body.browser.id}?chatThreadId=${sent.body.threadId}`,
      { headers: followupClaim.browserHeaders },
    );
    expect(hiddenAfterThreadDelete.status).toBe(404);

    expect(providerStops).toBe(3);

    const missing = await client().get({
      headers: followupClaim.browserHeaders,
      params: { browserId: created.body.browser.id },
      query: { chatThreadId: sent.body.threadId },
    });
    expect(missing.status).toBe(404);
    expect(providerCreateBodies).toStrictEqual([
      expect.objectContaining({
        profileId,
        proxyCountryCode: null,
        timeout: 30,
        enableRecording: false,
      }),
      expect.objectContaining({
        profileId,
        proxyCountryCode: null,
        timeout: 30,
        enableRecording: false,
      }),
      expect.objectContaining({
        profileId,
        proxyCountryCode: null,
        timeout: 30,
        enableRecording: false,
      }),
    ]);

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
    expect(providerStops).toBe(3);
  }, 90_000);
});
