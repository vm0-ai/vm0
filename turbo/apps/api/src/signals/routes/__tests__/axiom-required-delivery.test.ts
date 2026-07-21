import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";

import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { testContext } from "../../../__tests__/test-context";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const webhooks = createWebhookCallbackApi(context);
const { getDatasetName, ingestRequiredToAxiom } = await vi.importActual<
  typeof import("../../external/axiom")
>("../../external/axiom");

function successfulIngestStatus(ingested: number): Record<string, unknown> {
  return {
    ingested,
    failed: 0,
    failures: [],
    processedBytes: 1,
    blocksCreated: 0,
    walLength: ingested,
  };
}

describe("required Axiom route delivery", () => {
  it("rejects real SDK failures, succeeds on retry, and preserves telemetry token policy", async () => {
    const bdd = createBddApi(context);
    const connectors = createConnectorBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    let acceptAgentEvents = true;
    let acceptSandboxTelemetry = true;
    let agentEventAttempts = 0;
    let sandboxTelemetryAttempts = 0;
    context.mocks.axiom.useRealSdk.mockReturnValue(true);
    context.mocks.axiom.datasetName.mockImplementation(getDatasetName);
    context.mocks.axiom.requiredIngest.mockImplementation(
      ingestRequiredToAxiom,
    );
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.MemoryViewer]: false,
    });

    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/:dataset/ingest",
        async ({ params, request }) => {
          const dataset = String(params.dataset);
          const body = await request.text();
          const eventCount = body.length === 0 ? 0 : body.split("\n").length;
          if (dataset === "vm0-agent-run-events-dev") {
            agentEventAttempts += 1;
            if (!acceptAgentEvents) {
              return HttpResponse.json(
                { message: "agent events unavailable" },
                { status: 500 },
              );
            }
          }
          if (dataset === "vm0-sandbox-telemetry-system-dev") {
            sandboxTelemetryAttempts += 1;
            if (!acceptSandboxTelemetry) {
              return HttpResponse.json(
                { message: "sandbox telemetry unavailable" },
                { status: 500 },
              );
            }
          }
          return HttpResponse.json(successfulIngestStatus(eventCount));
        },
      ),
    );

    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Required Axiom Delivery Agent",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "verify required Axiom delivery",
      modelProvider: "anthropic-api-key",
    });
    const headers = {
      authorization: `Bearer ${runs.sandboxTokenForRun(actor, run.runId)}`,
    };
    const events = {
      runId: run.runId,
      events: [{ type: "system", sequenceNumber: 1 }],
    } satisfies Parameters<typeof webhooks.requestAgentEvents>[0];

    acceptAgentEvents = false;
    const failed = await webhooks.requestAgentEvents(events, headers, [500]);
    expectApiError(failed.body);
    expect(failed.body.error.message).toBe(
      "Required event consumer dispatch failed: axiom",
    );
    expect(agentEventAttempts).toBe(2);
    expect(context.mocks.axiomLogging.error).toHaveBeenCalledWith(
      'Event consumer "axiom" failed',
      expect.objectContaining({
        context: "webhook:events",
        error: expect.objectContaining({
          message:
            'Required Axiom ingest failed for sessions dataset "vm0-agent-run-events-dev"',
          cause: expect.objectContaining({
            message: "agent events unavailable",
          }),
        }),
        runId: run.runId,
      }),
    );

    acceptAgentEvents = true;
    const recovered = await webhooks.requestAgentEvents(events, headers, [200]);
    expect(recovered.body).toStrictEqual({
      received: 1,
      firstSequence: 1,
      lastSequence: 1,
    });

    acceptSandboxTelemetry = false;
    const telemetryFailed = await webhooks.requestAgentTelemetry(
      { runId: run.runId, systemLog: "sandbox booted" },
      headers,
      [500],
    );
    expect(telemetryFailed.status).toBe(500);
    expect(sandboxTelemetryAttempts).toBe(2);

    mockOptionalEnv("AXIOM_TOKEN_TELEMETRY", undefined);
    const telemetrySkipped = await webhooks.requestAgentTelemetry(
      { runId: run.runId, systemLog: "sandbox still running" },
      headers,
      [200],
    );
    expect(telemetrySkipped.body).toStrictEqual({
      success: true,
      id: run.runId,
    });
    expect(sandboxTelemetryAttempts).toBe(2);
  });
});
