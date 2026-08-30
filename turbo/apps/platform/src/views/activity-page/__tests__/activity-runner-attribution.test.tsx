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

function expectRunnerAttribute(label: string, value: string): void {
  const term = screen.getByText(label);
  const field = term.closest("div");
  if (!field) {
    throw new Error(`Runner attribution field not found: ${label}`);
  }
  expect(within(field).getByText(value)).toBeInTheDocument();
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

      await screen.findByRole("heading", { name: "Environment" });
      expectRunnerAttribute("Hostname", hostname);
      expectRunnerAttribute("Version", "0.168.14");
      expectRunnerAttribute("Runner ID", runnerId);
      expectRunnerAttribute("Generation", generation.toString());
      expect(screen.getByText("Sandbox reuse")).toBeInTheDocument();
      expect(screen.getAllByText("Reused")).toHaveLength(2);
    },
  );

  it.each([
    {
      runId: "a0000000-0000-4000-a000-000000000306",
      sandboxReuseResult: "reused",
      workspaceReuseResult: "sandboxReused",
      label: "Sandbox reuse",
      description: "The sandbox and its workspace were reused.",
    },
    {
      runId: "a0000000-0000-4000-a000-000000000307",
      sandboxReuseResult: "poolMiss",
      workspaceReuseResult: "reused",
      label: "Workspace reuse",
      description: "A fresh sandbox restored a cached workspace.",
    },
    {
      runId: "a0000000-0000-4000-a000-000000000308",
      sandboxReuseResult: "poolMiss",
      workspaceReuseResult: "cacheMiss",
      label: "Cold start",
      description: "A fresh sandbox and workspace were prepared.",
    },
    {
      runId: "a0000000-0000-4000-a000-000000000309",
      sandboxReuseResult: null,
      workspaceReuseResult: null,
      label: "Unknown",
      description: "Startup reuse details are unavailable.",
    },
  ] satisfies readonly {
    runId: string;
    sandboxReuseResult: RunRunnerResponse["sandboxReuseResult"];
    workspaceReuseResult: RunRunnerResponse["workspaceReuseResult"];
    label: string;
    description: string;
  }[])(
    "describes the $label startup path",
    async ({
      runId,
      sandboxReuseResult,
      workspaceReuseResult,
      label,
      description,
    }) => {
      mockActivity({
        runId,
        status: "completed",
        runner: { sandboxReuseResult, workspaceReuseResult },
      });

      setupRunnerPage(runId);

      const startupHeading = await screen.findByRole("heading", {
        name: "Startup",
      });
      const startupCard = startupHeading.closest("article");
      if (!startupCard) {
        throw new Error("Startup card not found");
      }
      expect(within(startupCard).getByText(label)).toBeInTheDocument();
      expect(within(startupCard).getByText(description)).toBeInTheDocument();
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
      expect.assertions(5);
      mockActivity({ runId, status, runner });

      setupRunnerPage(runId);

      await screen.findByRole("heading", { name: "Environment" });
      expectRunnerAttribute("Hostname", missing);
      expectRunnerAttribute("Version", missing);
      expectRunnerAttribute("Runner ID", missing);
      expectRunnerAttribute("Generation", missing);
      expect(
        screen.getAllByRole("article").every((card) => {
          return card.querySelector("p") !== null;
        }),
      ).toBeTruthy();
    },
  );
});
