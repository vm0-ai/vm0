import { screen, within } from "@testing-library/react";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import {
  runAgentEventsContract,
  runRunnerContract,
  type RunRunnerResponse,
} from "@okouai/api-contracts/contracts/run-routes";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type {
  AgentEventsResponse,
  LogDetail,
  LogStatus,
} from "../../../signals/okou-page/log-types.ts";

const context = testContext();

function logDetail(runId: string, status: LogStatus): LogDetail {
  return {
    id: runId,
    sessionId: "session-runner-attribution",
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Runner Attribution",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    status,
    prompt: "Inspect runner attribution",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-08-26T10:00:00Z",
    startedAt: status === "queued" ? null : "2026-08-26T10:00:01Z",
    completedAt: status === "completed" ? "2026-08-26T10:00:10Z" : null,
    artifact: { name: null, version: null },
  };
}

function mockActivity(args: {
  readonly runId: string;
  readonly status: LogStatus;
  readonly runner: RunRunnerResponse;
}): void {
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, logDetail(args.runId, args.status));
  });
  context.mocks.api(runAgentEventsContract.getAgentEvents, ({ respond }) => {
    return respond(200, {
      events: [],
      hasMore: false,
      status: args.status,
      lastEventSequence: null,
    } satisfies AgentEventsResponse);
  });
  context.mocks.api(runRunnerContract.getRunner, ({ respond }) => {
    return respond(200, args.runner);
  });
}

function setupRunnerPage(runId: string): void {
  detachedSetupPage({
    context,
    path: `/activities/${runId}?tab=runner`,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
}

function expectRunnerValue(label: string, value: string): void {
  const section = screen
    .getByRole("heading", { name: label })
    .closest("section");
  if (!section) {
    throw new Error(`Runner section not found: ${label}`);
  }
  expect(within(section).getByText(value)).toBeInTheDocument();
}

describe("activity runner attribution", () => {
  it.each([
    {
      runId: "a0000000-0000-4000-a000-000000000301",
      hostname: "prod-1.aws.vm3.ai",
      runnerId: "b0000000-0000-4000-a000-000000000001",
      generation: 7,
    },
    {
      runId: "a0000000-0000-4000-a000-000000000302",
      hostname: "prod-2.aws.vm3.ai",
      runnerId: "b0000000-0000-4000-a000-000000000002",
      generation: 8,
    },
  ])(
    "shows exact attribution for $hostname on the shared runner version",
    async ({ runId, hostname, runnerId, generation }) => {
      mockActivity({
        runId,
        status: "completed",
        runner: {
          sandboxReuseResult: "reused",
          workspaceReuseResult: "sandboxReused",
          runnerHostname: hostname,
          runnerVersion: "0.168.14",
          runnerId,
          runnerHeartbeatGeneration: generation,
        },
      });

      setupRunnerPage(runId);

      await screen.findByRole("heading", { name: "Hostname" });
      expectRunnerValue("Hostname", hostname);
      expectRunnerValue("Version", "0.168.14");
      expectRunnerValue("Runner ID", runnerId);
      expectRunnerValue("Generation", generation.toString());
      expect(screen.getByText("Sandbox reuse")).toBeInTheDocument();
      expect(screen.getAllByText("Reused")).toHaveLength(2);
    },
  );

  it.each([
    {
      name: "a previous API response",
      runId: "a0000000-0000-4000-a000-000000000303",
      status: "completed",
      runner: { sandboxReuseResult: null },
      missing: "Unavailable",
    },
    {
      name: "historical explicit-null attribution",
      runId: "a0000000-0000-4000-a000-000000000304",
      status: "completed",
      runner: {
        sandboxReuseResult: null,
        workspaceReuseResult: null,
        runnerHostname: null,
        runnerVersion: null,
        runnerId: null,
        runnerHeartbeatGeneration: null,
      },
      missing: "Unavailable",
    },
    {
      name: "an active run awaiting attribution",
      runId: "a0000000-0000-4000-a000-000000000305",
      status: "running",
      runner: {
        sandboxReuseResult: null,
        workspaceReuseResult: null,
        runnerHostname: null,
        runnerVersion: null,
        runnerId: null,
        runnerHeartbeatGeneration: null,
      },
      missing: "Provisioning",
    },
  ] satisfies readonly {
    name: string;
    runId: string;
    status: LogStatus;
    runner: RunRunnerResponse;
    missing: string;
  }[])(
    "shows $missing for $name",
    async ({ runId, status, runner, missing }) => {
      mockActivity({ runId, status, runner });

      setupRunnerPage(runId);

      await screen.findByRole("heading", { name: "Hostname" });
      expect(
        screen.getByRole("heading", { name: "Hostname" }),
      ).toBeInTheDocument();
      expectRunnerValue("Hostname", missing);
      expectRunnerValue("Version", missing);
      expectRunnerValue("Runner ID", missing);
      expectRunnerValue("Generation", missing);
    },
  );
});
