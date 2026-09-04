import { screen, within } from "@testing-library/react";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import {
  runAgentEventsContract,
  runRunnerContract,
  type RunRunnerResponse,
} from "@okouai/api-contracts/contracts/run-routes";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type {
  AgentEventsResponse,
  LogDetail,
  LogStatus,
} from "../../../signals/okou-page/log-types.ts";

const context = testContext();

interface ActivityFixture {
  readonly status: LogStatus;
  readonly runner: RunRunnerResponse;
}

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

function mockActivities(
  fixtures: Readonly<Record<string, ActivityFixture>>,
): void {
  context.mocks.api(logsByIdContract.getById, ({ params, respond }) => {
    const fixture = fixtures[params.id];
    if (!fixture) {
      throw new Error("Missing activity fixture for " + params.id);
    }
    return respond(200, logDetail(params.id, fixture.status));
  });
  context.mocks.api(
    runAgentEventsContract.getAgentEvents,
    ({ params, respond }) => {
      const fixture = fixtures[params.id];
      if (!fixture) {
        throw new Error("Missing activity fixture for " + params.id);
      }
      return respond(200, {
        events: [],
        hasMore: false,
        status: fixture.status,
        lastEventSequence: null,
      } satisfies AgentEventsResponse);
    },
  );
  context.mocks.api(runRunnerContract.getRunner, ({ params, respond }) => {
    const fixture = fixtures[params.id];
    if (!fixture) {
      throw new Error("Missing activity fixture for " + params.id);
    }
    return respond(200, fixture.runner);
  });
}

function setupRunnerPage(runId: string): Promise<void> {
  return setupPage({
    context,
    path: "/activities/" + runId + "?tab=runner",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
}

function navigateToRunner(runId: string): void {
  context.store.set(detachedNavigateTo$, "/activities/:activityRunId", {
    pathParams: { activityRunId: runId },
    searchParams: new URLSearchParams({ tab: "runner" }),
  });
}

function expectRunnerAttribute(label: string, value: string): void {
  const term = screen.getByText(label);
  const field = term.closest("div");
  if (!field) {
    throw new Error("Runner attribution field not found: " + label);
  }
  expect(within(field).getByText(value)).toBeInTheDocument();
}

function getStartupCard(): HTMLElement {
  const heading = screen.getByRole("heading", { name: "Startup" });
  const card = heading.closest("section");
  if (!card) {
    throw new Error("Startup card not found");
  }
  return card;
}

test("Runner diagnostics identify the exact environment used for an activity", async () => {
  const firstRunId = "a0000000-0000-4000-a000-000000000301";
  const secondRunId = "a0000000-0000-4000-a000-000000000302";
  mockActivities({
    [firstRunId]: {
      status: "completed",
      runner: {
        sandboxReuseResult: "reused",
        workspaceReuseResult: "sandboxReused",
        runnerHostname: "prod-1.aws.vm3.ai",
        runnerVersion: "0.168.14",
        runnerId: "b0000000-0000-4000-a000-000000000001",
        runnerHeartbeatGeneration: 7,
      },
    },
    [secondRunId]: {
      status: "completed",
      runner: {
        sandboxReuseResult: "reused",
        workspaceReuseResult: "sandboxReused",
        runnerHostname: "prod-2.aws.vm3.ai",
        runnerVersion: "0.168.14",
        runnerId: "b0000000-0000-4000-a000-000000000002",
        runnerHeartbeatGeneration: 8,
      },
    },
  });

  await setupRunnerPage(firstRunId);

  await expect(
    screen.findByRole("heading", { name: "Environment" }),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("prod-1.aws.vm3.ai"),
  ).resolves.toBeInTheDocument();
  expectRunnerAttribute("Version", "0.168.14");
  expectRunnerAttribute("Runner ID", "b0000000-0000-4000-a000-000000000001");
  expectRunnerAttribute("Generation", "7");
  expect(screen.getByText("Sandbox reuse")).toBeInTheDocument();
  expect(screen.getAllByText("Reused")).toHaveLength(2);

  navigateToRunner(secondRunId);

  await expect(
    screen.findByText("prod-2.aws.vm3.ai"),
  ).resolves.toBeInTheDocument();
  expectRunnerAttribute("Version", "0.168.14");
  expectRunnerAttribute("Runner ID", "b0000000-0000-4000-a000-000000000002");
  expectRunnerAttribute("Generation", "8");
  expect(screen.queryByText("prod-1.aws.vm3.ai")).not.toBeInTheDocument();
});

test("Runner diagnostics explain how the activity environment started", async () => {
  const cases = [
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
  ] as const satisfies readonly {
    runId: string;
    sandboxReuseResult: RunRunnerResponse["sandboxReuseResult"];
    workspaceReuseResult: RunRunnerResponse["workspaceReuseResult"];
    label: string;
    description: string;
  }[];
  mockActivities(
    Object.fromEntries(
      cases.map((entry) => {
        return [
          entry.runId,
          {
            status: "completed",
            runner: {
              sandboxReuseResult: entry.sandboxReuseResult,
              workspaceReuseResult: entry.workspaceReuseResult,
            },
          } satisfies ActivityFixture,
        ];
      }),
    ),
  );

  await setupRunnerPage(cases[0].runId);

  for (const [index, entry] of cases.entries()) {
    if (index > 0) {
      navigateToRunner(entry.runId);
    }
    await expect(screen.findByText(entry.label)).resolves.toBeInTheDocument();
    const startupCard = getStartupCard();
    expect(within(startupCard).getByText(entry.label)).toBeInTheDocument();
    expect(
      within(startupCard).getByText(entry.description),
    ).toBeInTheDocument();
  }
});

test("Missing runner attribution distinguishes active provisioning from historical absence", async () => {
  const activeRunId = "a0000000-0000-4000-a000-000000000305";
  const historicalRunId = "a0000000-0000-4000-a000-000000000304";
  mockActivities({
    [activeRunId]: {
      status: "running",
      runner: {
        sandboxReuseResult: null,
        workspaceReuseResult: null,
        runnerHostname: null,
        runnerVersion: null,
        runnerId: null,
        runnerHeartbeatGeneration: null,
      },
    },
    [historicalRunId]: {
      status: "completed",
      runner: {
        sandboxReuseResult: null,
        workspaceReuseResult: null,
        runnerHostname: null,
        runnerVersion: null,
        runnerId: null,
        runnerHeartbeatGeneration: null,
      },
    },
  });

  await setupRunnerPage(activeRunId);

  await expect(
    screen.findByRole("heading", { name: "Environment" }),
  ).resolves.toBeInTheDocument();
  expectRunnerAttribute("Hostname", "Provisioning");
  expectRunnerAttribute("Version", "Provisioning");
  expectRunnerAttribute("Runner ID", "Provisioning");
  expectRunnerAttribute("Generation", "Provisioning");

  navigateToRunner(historicalRunId);

  await screen.findAllByText("Unavailable");
  expectRunnerAttribute("Hostname", "Unavailable");
  expectRunnerAttribute("Version", "Unavailable");
  expectRunnerAttribute("Runner ID", "Unavailable");
  expectRunnerAttribute("Generation", "Unavailable");
  expect(
    screen.getAllByRole("article").every((card) => {
      return card.querySelector("p") !== null;
    }),
  ).toBeTruthy();
});
