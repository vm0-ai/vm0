import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NetworkLogEntry } from "@vm0/api-contracts/contracts/runs";
import type { RunContextResponse } from "@vm0/api-contracts/contracts/zero-runs";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type {
  AgentEvent,
  LogDetail,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();
const user = userEvent.setup();

function inspectFile(): File {
  const meta: Partial<LogDetail> = {
    id: "b0000000-0000-4000-a000-000000000777",
    sessionId: "session-inspect",
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Imported Analysis",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "cli",
    triggerAgentName: null,
    automationId: null,
    status: "completed",
    prompt: "Inspect the latest OAuth trace",
    appendSystemPrompt: "Prefer concise findings",
    error: null,
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: "2026-03-10T14:56:06Z",
  };
  const events: AgentEvent[] = [
    {
      sequenceNumber: 0,
      eventType: "assistant",
      eventData: {
        message: {
          content: [
            {
              type: "text",
              text: "Collected OAuth evidence from network logs.",
            },
          ],
        },
      },
      createdAt: "2026-03-10T14:56:02Z",
    },
    {
      sequenceNumber: 1,
      eventType: "assistant",
      eventData: {
        message: {
          content: [
            {
              type: "text",
              text: "Summarized billing status for the workspace.",
            },
          ],
        },
      },
      createdAt: "2026-03-10T14:56:04Z",
    },
  ];
  const runContext: RunContextResponse = {
    prompt: "Inspect the latest OAuth trace",
    appendSystemPrompt: "Prefer concise findings",
    runId: "b0000000-0000-4000-a000-000000000777",
    sessionId: "session-inspect",
    secretNames: ["github-token"],
    vars: { ACCOUNT_ID: "acct_123" },
    environment: { NODE_ENV: "test" },
    firewalls: [
      {
        name: "github",
        apis: [
          {
            base: "https://api.github.com",
            permissions: [
              {
                name: "read-repos",
                description: "Read repositories",
                rules: ["GET /repos/*"],
              },
            ],
          },
        ],
      },
    ],
    networkPolicies: null,
    volumes: [
      {
        name: "workspace",
        mountPath: "/workspace",
        vasStorageName: "storage-workspace",
        vasVersionId: "version-1",
      },
    ],
    artifact: {
      mountPath: "/artifact",
      vasStorageName: "artifact-storage",
      vasVersionId: "artifact-version",
    },
    featureFlags: { zeroDebug: true },
  };
  const networkLogs: NetworkLogEntry[] = [
    {
      timestamp: "2026-03-10T14:56:03.000Z",
      type: "http",
      action: "ALLOW",
      method: "GET",
      url: "https://api.github.com/repos/vm0-ai/vm0",
      status: 200,
      latency_ms: 123,
      request_size: 42,
      response_size: 2048,
      firewall_name: "github",
      firewall_permission: "read-repos",
      browser_user_agent: true,
    },
  ];

  return new File(
    [
      JSON.stringify({
        meta,
        events,
        context: runContext,
        networkLogs,
      }),
    ],
    "activity-log.json",
    { type: "application/json" },
  );
}

function getFileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Could not find inspect log file input");
  }
  return input;
}

function getTabByText(text: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((el) => {
    return el.textContent?.trim() === text;
  });
  if (!tab) {
    throw new Error(`Could not find tab: ${text}`);
  }
  return tab;
}

describe("activity inspect page", () => {
  it("loads an exported log and lets the user inspect steps, context, and network data", async () => {
    detachedSetupPage({
      context,
      path: "/activities/inspect",
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("No log loaded")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Upload an activity log JSON file to inspect it."),
    ).toBeInTheDocument();

    await user.upload(getFileInput(), inspectFile());

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Imported Analysis" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("5.0s")).toBeInTheDocument();
    expect(
      screen.getByText("Collected OAuth evidence from network logs."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Summarized billing status for the workspace."),
    ).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Search steps"), "OAuth");

    await waitFor(() => {
      expect(screen.getByText("(1/2 matched)")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Collected OAuth evidence from network logs."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Summarized billing status for the workspace."),
    ).not.toBeInTheDocument();

    click(getTabByText("Context"));

    await waitFor(() => {
      expect(screen.getByText("github-token")).toBeInTheDocument();
    });
    expect(screen.getByText("ACCOUNT_ID")).toBeInTheDocument();
    expect(screen.getByText("acct_123")).toBeInTheDocument();
    expect(screen.getByText("storage-workspace")).toBeInTheDocument();

    click(getTabByText("Network"));

    await waitFor(() => {
      expect(
        screen.getByText("https://api.github.com/repos/vm0-ai/vm0"),
      ).toBeInTheDocument();
    });
    const networkTable = screen.getByRole("table");
    expect(within(networkTable).getByText("GET")).toBeInTheDocument();
    expect(within(networkTable).getByText("200")).toBeInTheDocument();
    expect(within(networkTable).getByText("123ms")).toBeInTheDocument();
    expect(within(networkTable).getByText("github")).toBeInTheDocument();
  });
});
