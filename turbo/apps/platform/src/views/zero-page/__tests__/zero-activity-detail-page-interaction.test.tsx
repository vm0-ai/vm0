import { assert, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import {
  FeatureSwitchKey,
  type RunContextResponse,
  logsByIdContract,
  zeroRunAgentEventsContract,
  zeroRunContextContract,
  zeroRunNetworkLogsContract,
} from "@vm0/core";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

const BASE_LOG_ID = "b0000000-0000-4000-b000-000000000001";

function makeLogDetail(): LogDetail {
  return {
    id: BASE_LOG_ID,
    sessionId: "session_int",
    agentId: "test-agent",
    displayName: "Interaction Test Agent",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    triggerAgentName: null,
    scheduleId: null,
    status: "completed",
    prompt: "What is the capital of France?",
    appendSystemPrompt: "You are a helpful assistant.",
    error: null,
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: "2026-03-10T14:56:10Z",
    artifact: { name: null, version: null },
  };
}

function makeEventsResponse(): AgentEventsResponse {
  return {
    events: [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              { type: "text", text: "Paris is the capital of France." },
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
            content: [{ type: "text", text: "The Eiffel Tower is in Paris." }],
          },
        },
        createdAt: "2026-03-10T14:56:03Z",
      },
    ],
    hasMore: false,
    framework: "claude-code",
  };
}

function setupBaseMocks() {
  server.use(
    mockApi(logsByIdContract.getById, ({ params, respond }) => {
      if (params.id === BASE_LOG_ID) {
        return respond(200, makeLogDetail());
      }
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }),
    mockApi(zeroRunAgentEventsContract.getAgentEvents, ({ respond }) => {
      return respond(200, makeEventsResponse());
    }),
  );
}

describe("zeroActivityDetailPageInteraction", () => {
  it("should filter steps when searching (ACT-D-028)", async () => {
    setupBaseMocks();
    const user = userEvent.setup();

    detachedSetupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Interaction Test Agent" }),
      ).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("2 total")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search steps");
    await user.type(searchInput, "Eiffel");

    await waitFor(() => {
      expect(screen.getByText(/1\/2 matched/)).toBeInTheDocument();
    });
  });

  it("should trigger download when download button is clicked (ACT-D-029)", async () => {
    setupBaseMocks();

    server.use(
      mockApi(zeroRunContextContract.getContext, ({ respond }) => {
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }),
      mockApi(zeroRunNetworkLogsContract.getNetworkLogs, ({ respond }) => {
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }),
    );

    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:test");
    vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {
        return undefined;
      });

    detachedSetupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Interaction Test Agent" }),
      ).toBeInTheDocument();
    });

    const downloadButton = screen.getByLabelText("Download raw data");
    click(downloadButton);

    await waitFor(() => {
      expect(createObjectURLSpy).toHaveBeenCalledOnce();
    });
    const capturedArg = createObjectURLSpy.mock.calls[0]?.[0];
    assert(
      capturedArg instanceof Blob,
      "createObjectURL should be called with a Blob",
    );
    expect(capturedArg.type).toBe("application/json;charset=utf-8;");
    const blobText = await capturedArg.text();
    expect(blobText).toContain(BASE_LOG_ID);
    expect(anchorClickSpy).toHaveBeenCalledOnce();
  });

  it("should switch to context tab when clicked (ACT-D-030)", async () => {
    setupBaseMocks();

    const contextResponse: RunContextResponse = {
      prompt: "What is the capital of France?",
      appendSystemPrompt: null,
      runId: "run-test-id",
      sessionId: null,
      secretNames: [],
      vars: null,
      environment: {},
      firewalls: [],
      volumes: [],
      artifact: null,
      networkPolicies: null,
      featureFlags: null,
    };

    server.use(
      mockApi(zeroRunContextContract.getContext, ({ respond }) => {
        return respond(200, contextResponse);
      }),
    );

    detachedSetupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Interaction Test Agent" }),
      ).toBeInTheDocument();
    });

    const contextTab = screen.getByText("Context");
    click(contextTab);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Prompt", level: 3 }),
      ).toBeInTheDocument();
    });
  });

  it("should expand and collapse the system prompt section (ACT-D-031)", async () => {
    setupBaseMocks();

    detachedSetupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
      featureSwitches: { [FeatureSwitchKey.ShowSystemPrompt]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("System Prompt")).toBeInTheDocument();
    });

    // The <details> element is initially closed — content paragraph is not visible
    const promptParagraph = () => {
      return screen.getAllByText("You are a helpful assistant.").find((el) => {
        return el.tagName === "P";
      });
    };
    expect(promptParagraph()).not.toBeVisible();

    click(screen.getByText("System Prompt"));

    await waitFor(() => {
      expect(promptParagraph()).toBeVisible();
    });

    click(screen.getByText("System Prompt"));

    await waitFor(() => {
      expect(promptParagraph()).not.toBeVisible();
    });
  });
});
