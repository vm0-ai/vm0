import { createHash, randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { testAgentRunsContract } from "@vm0/api-contracts/contracts/test-agent-runs";
import { HttpResponse, http } from "msw";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { generateSandboxToken } from "../../auth/tokens";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { seedAgentRunCallback$ } from "./helpers/agent-run-callback";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const bdd = createBddApi(context);
const reads = createRunReadsApi(context);
const runs = createRunsApi(context);
const mocks = createZeroRouteMocks(context);
const webhooks = createWebhookCallbackApi(context);
const callbackStore = createStore();
const OPENROUTER_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";

function client() {
  return setupApp({ context })(testAgentRunsContract);
}

function authenticate(actor: ApiTestUser): {
  readonly authorization: string;
} {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

async function seedDirectRunActor(): Promise<{
  readonly actor: ApiTestUser;
  readonly composeId: string;
}> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);

  const name = `test-agent-runs-${randomUUID().slice(0, 8)}`;
  const compose = await runs.createCompose(actor, {
    version: "1",
    agents: {
      [name]: {
        framework: "claude-code",
        environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
      },
    },
  });

  return { actor, composeId: compose.composeId };
}

describe("POST /api/test/agent-runs", () => {
  it("rejects a malformed request body", async () => {
    mockEnv("ENV", "development");
    const actor = bdd.user();
    const app = createApp({ signal: context.signal });
    const response = await app.request("/api/test/agent-runs", {
      method: "POST",
      headers: {
        ...authenticate(actor),
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentComposeId: randomUUID() }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("creates a direct run when the test endpoint is allowed", async () => {
    mockEnv("ENV", "development");
    const { actor, composeId } = await seedDirectRunActor();

    const response = await accept(
      client().create({
        headers: authenticate(actor),
        body: {
          agentComposeId: composeId,
          prompt: "create a runner E2E fixture",
        },
      }),
      [201],
    );

    expect(response.body).toMatchObject({
      runId: expect.any(String),
      sessionId: expect.any(String),
      status: expect.stringMatching(
        /^(queued|pending|running|completed|failed|timeout|cancelled)$/,
      ),
    });

    await expect(
      runs.readRun(actor, response.body.runId),
    ).resolves.toMatchObject({
      runId: response.body.runId,
      prompt: "create a runner E2E fixture",
    });

    const logs = await reads.requestListLogs(actor, {}, [200]);
    expect(logs.body.data).toContainEqual(
      expect.objectContaining({
        id: response.body.runId,
        triggerSource: "test",
      }),
    );

    await runs.requestCancelRun(actor, response.body.runId, [200]);
  });

  it("uses DB-only output when the projection is unavailable", async () => {
    mockEnv("ENV", "development");
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-openrouter-key");
    const { actor, composeId } = await seedDirectRunActor();
    const summaryRequests: unknown[] = [];
    server.use(
      http.post(OPENROUTER_COMPLETIONS_URL, async ({ request }) => {
        summaryRequests.push(await request.json());
        return HttpResponse.json({
          choices: [{ message: { content: "Empty output summarized" } }],
        });
      }),
    );

    const response = await accept(
      client().create({
        headers: authenticate(actor),
        body: {
          agentComposeId: composeId,
          prompt: "complete without projected output",
        },
      }),
      [201],
    );
    await callbackStore.set(
      seedAgentRunCallback$,
      {
        runId: response.body.runId,
        internalKind: "agent",
        payload: {},
      },
      context.signal,
    );
    const claim = await runs.claimRunnerJob(response.body.runId);
    const sandboxHeaders = {
      authorization: `Bearer ${claim.sandboxToken}`,
    };
    context.mocks.axiom.query.mockImplementation((apl: unknown) => {
      if (typeof apl === "string" && apl.includes("agent-run-events")) {
        throw new Error("Missing DB output should not query Axiom");
      }
      return Promise.resolve([]);
    });
    context.mocks.axiom.query.mockClear();
    await webhooks.requestAgentCheckpoint(
      {
        runId: response.body.runId,
        cliAgentType: "claude-code",
        cliAgentSessionId: `db-only-${response.body.runId}`,
        cliAgentSessionHistoryHash: createHash("sha256")
          .update(`db-only output ${response.body.runId}`)
          .digest("hex"),
      },
      sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId: response.body.runId,
        exitCode: 0,
        lastEventSequence: 0,
      },
      sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();

    expect(JSON.stringify(summaryRequests)).toContain(
      "complete without projected output",
    );
  });

  it("returns 404 when the test endpoint is not allowed", async () => {
    mockEnv("ENV", "production");
    const actor = bdd.user();

    const response = await accept(
      client().create({
        headers: authenticate(actor),
        body: { prompt: "production must not create a run" },
      }),
      [404],
    );

    expect(response.body).toBe("Not found");
  });

  it("rejects a sandbox token", async () => {
    mockEnv("ENV", "development");
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped test actor");
    }
    const token = generateSandboxToken(actor.userId, randomUUID(), actor.orgId);

    const response = await accept(
      client().create({
        headers: { authorization: `Bearer ${token}` },
        body: { prompt: "sandbox tokens cannot create runs" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "This endpoint is not available for sandbox tokens",
        code: "FORBIDDEN",
      },
    });
  });
});
