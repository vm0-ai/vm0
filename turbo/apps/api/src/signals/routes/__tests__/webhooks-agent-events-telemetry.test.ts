import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { server } from "../../../mocks/server";
import { createBddApi } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);

describe("POST /api/webhooks/agent/events telemetry", () => {
  it("redacts legacy Pi transcript payloads before Axiom ingest", async () => {
    const actor = bdd.user();
    chatCallbacks.acceptChatObjectStorage();
    chatCallbacks.disableVapid();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Legacy Pi telemetry guard",
      visibility: "private",
    });
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "verify legacy Pi telemetry redaction",
        clientEventId: randomUUID(),
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the chat send to create a thread-bound run");
    }
    const runId = sent.body.runId;

    const ingestedBodies: unknown[] = [];
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/agent-run-events/ingest",
        async ({ request }) => {
          ingestedBodies.push(await request.json());
          return HttpResponse.json({
            ingested: 1,
            failed: 0,
            processedBytes: 0,
          });
        },
      ),
    );

    const secretTranscript = "private legacy Pi transcript";
    const response = await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "pi.message.completed",
            sequenceNumber: 1,
            messageId: "pi-legacy-message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: secretTranscript }],
              api: "openai-completions",
              provider: "deepseek",
              model: "deepseek-chat",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              stopReason: "stop",
              timestamp: 1,
            },
          },
        ],
      },
      webhooks.sandboxWebhookHeaders({ runId }),
      [200],
    );
    expect(response.body).toStrictEqual({
      received: 1,
      firstSequence: 1,
      lastSequence: 1,
    });

    await flushWaitUntilForTest();
    expect(ingestedBodies).toStrictEqual([
      [
        {
          runId,
          userId: "user_bdd_sandbox_webhook",
          sequenceNumber: 1,
          eventType: "pi.message.completed",
          eventData: {
            type: "pi.message.completed",
            source: "sandbox",
            sequenceNumber: 1,
            messageId: "pi-legacy-message",
            role: "assistant",
            payloadBytes: expect.any(Number),
          },
        },
      ],
    ]);
    expect(JSON.stringify(ingestedBodies)).not.toContain(secretTranscript);
  });
});
