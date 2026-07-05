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
import { createDeferredPromise } from "../../../signals/utils.ts";
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

function inspectPayload(displayName: string, text: string) {
  return {
    meta: {
      displayName,
      status: "completed",
      triggerSource: "cli",
      createdAt: "2026-03-10T14:56:00Z",
      startedAt: "2026-03-10T14:56:01Z",
      completedAt: "2026-03-10T14:56:02Z",
    },
    events: [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "text",
                text,
              },
            ],
          },
        },
        createdAt: "2026-03-10T14:56:02Z",
      },
    ],
  };
}

function inspectFileWithDeferredText(
  fileName: string,
  textPromise: Promise<string>,
): File {
  const file = new File([], fileName, { type: "application/json" });
  Object.defineProperty(file, "text", {
    value: () => {
      return textPromise;
    },
  });
  return file;
}

function codexInspectFile(): File {
  const meta: Partial<LogDetail> = {
    id: "b0000000-0000-4000-a000-000000000778",
    sessionId: "codex-inspect-session",
    agentId: "c0000000-0000-4000-a000-000000000002",
    displayName: "Imported Codex Adapter Log",
    framework: "codex",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "cli",
    triggerAgentName: null,
    status: "failed",
    prompt: "Inspect Codex adapter events",
    appendSystemPrompt: "Prefer normalized Codex rows",
    error: "Inspect adapter failed",
    createdAt: "2026-03-10T16:56:00Z",
    startedAt: "2026-03-10T16:56:01Z",
    completedAt: "2026-03-10T16:56:06Z",
  };
  const events: AgentEvent[] = [
    {
      sequenceNumber: 0,
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        turn_id: "inspect-turn-1",
        item: {
          id: "inspect-message",
          type: "agent_message",
          status: "completed",
          text: "Codex inspect assistant output remains visible.",
        },
      },
      createdAt: "2026-03-10T16:56:02Z",
    },
    {
      sequenceNumber: 1,
      eventType: "warning",
      eventData: {
        type: "warning",
        thread_id: "codex-inspect-session",
        message: "Inspect adapter warning",
      },
      createdAt: "2026-03-10T16:56:03Z",
    },
    {
      sequenceNumber: 2,
      eventType: "turn.plan.updated",
      eventData: {
        type: "turn.plan.updated",
        turn_id: "inspect-turn-1",
        explanation: "Inspect normalized plan",
        plan: [{ step: "Review imported Codex event", status: "completed" }],
      },
      createdAt: "2026-03-10T16:56:04Z",
    },
    {
      sequenceNumber: 3,
      eventType: "error",
      eventData: {
        type: "error",
        turn_id: "inspect-turn-1",
        message: "Inspect transport failed",
        error: {
          message: "Inspect transport failed",
          additional_details: "inspect socket closed",
        },
      },
      createdAt: "2026-03-10T16:56:05Z",
    },
    {
      sequenceNumber: 4,
      eventType: "turn.completed",
      eventData: {
        type: "turn.completed",
        turn: {
          id: "inspect-turn-1",
          status: "failed",
          error: {
            message: "Inspect turn failed",
            codex_error_info: "inspect model stopped",
          },
        },
      },
      createdAt: "2026-03-10T16:56:06Z",
    },
  ];
  const runContext: RunContextResponse = {
    prompt: "Inspect Codex adapter events",
    appendSystemPrompt: "Prefer normalized Codex rows",
    runId: "b0000000-0000-4000-a000-000000000778",
    sessionId: "codex-inspect-session",
    secretNames: [],
    vars: {},
    environment: {},
    firewalls: [],
    networkPolicies: null,
    volumes: [],
    artifact: null,
    featureFlags: { zeroDebug: true },
  };

  return new File(
    [
      JSON.stringify({
        meta,
        events,
        context: runContext,
        networkLogs: [],
      }),
    ],
    "codex-activity-log.json",
    { type: "application/json" },
  );
}

function malformedInspectFile(): File {
  return new File(
    [
      JSON.stringify({
        meta: {
          displayName: { nested: true },
          status: "not-a-status",
          triggerSource: "not-a-source",
          prompt: { nested: true },
          appendSystemPrompt: { nested: true },
          createdAt: "bad-log-created-at",
          startedAt: "bad-started-at",
          completedAt: "bad-completed-at",
        },
        events: [
          null,
          {
            sequenceNumber: "bad-sequence",
            eventType: "assistant",
            eventData: {
              message: {
                content: [{ type: "text", text: "Invalid event is dropped." }],
              },
            },
            createdAt: "2026-03-10T17:00:01Z",
          },
          {
            sequenceNumber: 0,
            eventType: "assistant",
            eventData: {
              message: {
                content: [
                  {
                    type: "text",
                    text: "Valid imported event survives.",
                  },
                ],
              },
            },
            createdAt: "bad-created-at",
          },
          {
            sequenceNumber: 1,
            eventType: "result",
            eventData: {
              type: "result",
              is_error: false,
              result: "Negative duration result survives.",
              duration_ms: -100,
              num_turns: 1,
            },
            createdAt: "2026-03-10T17:00:03Z",
          },
        ],
        context: { bad: true },
        networkLogs: [
          null,
          {
            timestamp: "not-a-date",
            type: "http",
            method: "GET",
            url: "https://example.com/imported-valid-network-log",
            latency_ms: -5,
          },
          {
            timestamp: { nested: true },
            url: "https://example.com/invalid-network-log",
          },
        ],
      }),
    ],
    "malformed-activity-log.json",
    { type: "application/json" },
  );
}

function oversizedInspectFile(): File {
  const file = new File(["{}"], "oversized-activity-log.json", {
    type: "application/json",
  });
  Object.defineProperty(file, "size", {
    value: 26 * 1024 * 1024,
  });
  Object.defineProperty(file, "text", {
    value: () => {
      return Promise.reject(new Error("oversized file should not be read"));
    },
  });
  return file;
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

  it("ignores debug tab query params when debug tabs are disabled", async () => {
    detachedSetupPage({
      context,
      path: "/activities/inspect?tab=context",
    });

    await waitFor(() => {
      expect(screen.getByText("No log loaded")).toBeInTheDocument();
    });

    await user.upload(getFileInput(), inspectFile());

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Imported Analysis" }),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText("Collected OAuth evidence from network logs."),
    ).toBeInTheDocument();
    expect(
      queryAllByRoleFast("tab").some((element) => {
        return element.textContent === "Context";
      }),
    ).toBeFalsy();
    expect(screen.queryByText("github-token")).not.toBeInTheDocument();
  });

  it("keeps the newest uploaded log when file reads resolve out of order", async () => {
    detachedSetupPage({
      context,
      path: "/activities/inspect",
    });

    await waitFor(() => {
      expect(screen.getByText("No log loaded")).toBeInTheDocument();
    });

    const staleRead = createDeferredPromise<string>(AbortSignal.any([]));
    const latestRead = createDeferredPromise<string>(AbortSignal.any([]));

    await user.upload(
      getFileInput(),
      inspectFileWithDeferredText("stale-log.json", staleRead.promise),
    );
    await user.upload(
      getFileInput(),
      inspectFileWithDeferredText("latest-log.json", latestRead.promise),
    );

    latestRead.resolve(
      JSON.stringify(inspectPayload("Latest Imported Log", "latest log text")),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Latest Imported Log" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("latest log text")).toBeInTheDocument();

    staleRead.resolve(
      JSON.stringify(inspectPayload("Stale Imported Log", "stale log text")),
    );
    await staleRead.promise;

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Latest Imported Log" }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("heading", { name: "Stale Imported Log" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("stale log text")).not.toBeInTheDocument();
  });

  it("normalizes imported codex adapter events", async () => {
    detachedSetupPage({
      context,
      path: "/activities/inspect",
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("No log loaded")).toBeInTheDocument();
    });

    await user.upload(getFileInput(), codexInspectFile());

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Imported Codex Adapter Log" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(
      screen.getByText("Codex inspect assistant output remains visible."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("[warning] Inspect adapter warning"),
    ).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => {
        return (
          element?.tagName === "P" &&
          element.textContent?.includes("Inspect normalized plan") === true
        );
      }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(
        /Inspect transport failed \(inspect socket closed\)/u,
      ),
    ).toHaveLength(1);
    expect(
      screen.getByText(/Inspect turn failed \(inspect model stopped\)/u),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/u)).not.toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText("Search steps"),
      "Inspect adapter warning",
    );

    await waitFor(() => {
      expect(screen.getByText("(1/4 matched)")).toBeInTheDocument();
    });
    expect(
      screen.getByText("[warning] Inspect adapter warning"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText((_, element) => {
        return (
          element?.tagName === "P" &&
          element.textContent?.includes("Inspect normalized plan") === true
        );
      }),
    ).not.toBeInTheDocument();
  });

  it("loads malformed imported logs without crashing", async () => {
    detachedSetupPage({
      context,
      path: "/activities/inspect",
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("No log loaded")).toBeInTheDocument();
    });

    await user.upload(getFileInput(), malformedInspectFile());

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Imported Log" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(
      screen.getByText("Valid imported event survives."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Negative duration result survives."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Invalid event is dropped."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/u)).not.toBeInTheDocument();
    expect(screen.getByText("bad-log-created-at")).toBeInTheDocument();
    expect(screen.getAllByText("bad-created-at").length).toBeGreaterThan(0);
    expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/u)).not.toBeInTheDocument();
    expect(screen.queryByText("-100ms")).not.toBeInTheDocument();

    click(getTabByText("Context"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Context not available" }),
      ).toBeInTheDocument();
    });

    click(getTabByText("Network"));

    await waitFor(() => {
      expect(
        screen.getByText("https://example.com/imported-valid-network-log"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("not-a-date")).toBeInTheDocument();
    expect(screen.queryByText("-5ms")).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/u)).not.toBeInTheDocument();
    expect(
      screen.queryByText("https://example.com/invalid-network-log"),
    ).not.toBeInTheDocument();
  });

  it("rejects oversized imported logs before reading them", async () => {
    detachedSetupPage({
      context,
      path: "/activities/inspect",
    });

    await waitFor(() => {
      expect(screen.getByText("No log loaded")).toBeInTheDocument();
    });

    await user.upload(getFileInput(), oversizedInspectFile());

    await waitFor(() => {
      expect(
        screen.getByText(
          "JSON file is too large. Upload an exported activity log JSON file under 25 MB.",
        ),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("heading", { name: "Imported Log" }),
    ).not.toBeInTheDocument();
  });

  it("shows an upload error for invalid JSON and recovers on the next file", async () => {
    detachedSetupPage({
      context,
      path: "/activities/inspect",
    });

    await waitFor(() => {
      expect(screen.getByText("No log loaded")).toBeInTheDocument();
    });

    await user.upload(
      getFileInput(),
      new File(["{ invalid json"], "invalid-log.json", {
        type: "application/json",
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Invalid JSON file. Upload an exported activity log JSON file.",
        ),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("heading", { name: "Imported Analysis" }),
    ).not.toBeInTheDocument();

    await user.upload(getFileInput(), inspectFile());

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Imported Analysis" }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText(
        "Invalid JSON file. Upload an exported activity log JSON file.",
      ),
    ).not.toBeInTheDocument();
  });

  it("shows an upload error for non-object JSON files", async () => {
    detachedSetupPage({
      context,
      path: "/activities/inspect",
    });

    await waitFor(() => {
      expect(screen.getByText("No log loaded")).toBeInTheDocument();
    });

    await user.upload(
      getFileInput(),
      new File(["[]"], "array-log.json", {
        type: "application/json",
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Invalid JSON file. Upload an exported activity log JSON file.",
        ),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("heading", { name: "Imported Log" }),
    ).not.toBeInTheDocument();
  });
});
