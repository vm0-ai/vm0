import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
import type { NetworkLogEntry } from "@vm0/api-contracts/contracts/runs";
import {
  zeroRunAgentEventsContract,
  zeroRunContextContract,
  zeroRunNetworkLogsContract,
  type RunContextResponse,
} from "@vm0/api-contracts/contracts/zero-runs";

import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type {
  AgentEvent,
  LogDetail,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();

const RUN_ID = "a0000000-0000-4000-a000-000000000399";

function logDetail(): LogDetail {
  return {
    id: RUN_ID,
    sessionId: "session-1",
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Checkout Export",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    status: "completed",
    prompt: "Export checkout diagnostics",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: "2026-03-10T14:56:10Z",
    artifact: { name: null, version: null },
  };
}

function runContext(): RunContextResponse {
  return {
    prompt: "Export checkout diagnostics",
    appendSystemPrompt: null,
    runId: RUN_ID,
    sessionId: "session-1",
    cliAgentType: "codex",
    secretNames: [],
    vars: null,
    environment: {},
    firewalls: [],
    networkPolicies: null,
    volumes: [],
    artifact: null,
    featureFlags: null,
  };
}

function networkLog(): NetworkLogEntry {
  return {
    timestamp: "2026-03-10T14:56:03Z",
    type: "http",
    action: "ALLOW",
    host: "payments.example.test",
    port: 443,
    method: "POST",
    url: "https://payments.example.test/v1/checkout",
    status: 200,
  };
}

function activityEvent(): AgentEvent {
  return {
    sequenceNumber: 0,
    eventType: "assistant",
    eventData: {
      message: {
        content: [{ type: "text", text: "Checkout diagnostics exported" }],
      },
    },
    createdAt: "2026-03-10T14:56:02Z",
  };
}

describe("activity retained diagnostic data", () => {
  it("renders not found when the activity is missing or inaccessible", async () => {
    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Log not found" },
      });
    });

    detachedSetupPage({ context, path: `/activities/${RUN_ID}` });

    await expect(
      screen.findByRole("heading", { name: "Log not found" }),
    ).resolves.toBeInTheDocument();
  });

  it("downloads events with metadata, context, and network data", async () => {
    const downloads = context.mocks.browser.blobDownload();
    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(200, logDetail());
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: [activityEvent()],
          hasMore: false,
          framework: "claude-code",
        });
      },
    );
    context.mocks.api(zeroRunContextContract.getContext, ({ respond }) => {
      return respond(200, runContext());
    });
    context.mocks.api(
      zeroRunNetworkLogsContract.getNetworkLogs,
      ({ respond }) => {
        return respond(200, {
          networkLogs: [networkLog()],
          hasMore: false,
        });
      },
    );

    detachedSetupPage({ context, path: `/activities/${RUN_ID}` });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Checkout Export" }),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Download raw data"));
    await waitFor(() => {
      expect(downloads.downloads).toHaveLength(1);
    });

    const download = downloads.downloads[0];
    if (!download?.blob) {
      throw new Error("Downloaded activity blob was not captured");
    }
    const downloaded = JSON.parse(await download.blob.text()) as Record<
      string,
      unknown
    >;

    expect(download.filename).toBe(`${RUN_ID}-activity.json`);
    expect(downloaded.events).toStrictEqual([activityEvent()]);
    expect(downloaded.meta).toMatchObject({
      id: RUN_ID,
      displayName: "Checkout Export",
      framework: "codex",
    });
    expect(downloaded.context).toMatchObject({ runId: RUN_ID });
    expect(downloaded.networkLogs).toStrictEqual([networkLog()]);
  });

  it("keeps downloads available when context is unavailable", async () => {
    const downloads = context.mocks.browser.blobDownload();
    context.mocks.data.composesList([]);
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(200, logDetail());
    });
    context.mocks.api(zeroRunContextContract.getContext, ({ respond }) => {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Run context not available" },
      });
    });
    context.mocks.api(
      zeroRunNetworkLogsContract.getNetworkLogs,
      ({ respond }) => {
        return respond(200, { networkLogs: [], hasMore: false });
      },
    );

    detachedSetupPage({ context, path: `/activities/${RUN_ID}` });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Checkout Export" }),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Download raw data"));
    await waitFor(() => {
      expect(downloads.downloads).toHaveLength(1);
    });

    const download = downloads.downloads[0];
    if (!download?.blob) {
      throw new Error("Downloaded activity blob was not captured");
    }
    const downloaded = JSON.parse(await download.blob.text()) as Record<
      string,
      unknown
    >;

    expect(download.filename).toBe(`${RUN_ID}-activity.json`);
    expect(downloaded).not.toHaveProperty("context");
    expect(downloaded.networkLogs).toStrictEqual([]);
  });
});
