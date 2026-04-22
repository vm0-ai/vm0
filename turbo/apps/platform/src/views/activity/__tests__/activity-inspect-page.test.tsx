import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/core";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import {
  loadInspectLogFile$,
  inspectStepSearch$,
  setInspectStepSearch$,
  type InspectLogData,
} from "../../../signals/activity-page/inspect-log-signals.ts";
import type { InspectLogMeta } from "../../../signals/activity-page/inspect-log-parser.ts";
import type { AgentEvent } from "../../../signals/zero-page/log-types.ts";

const context = testContext();

function makeInspectData(
  metaOverrides: Partial<InspectLogMeta> = {},
  events: AgentEvent[] = [],
): InspectLogData {
  return {
    meta: {
      id: "inspect-test-001",
      displayName: "Test Inspect Agent",
      status: "completed",
      triggerSource: "cli",
      triggerAgentName: null,
      modelProvider: null,
      selectedModel: null,
      framework: "claude-code",
      error: null,
      scheduleId: null,
      prompt: "Test prompt text",
      appendSystemPrompt: null,
      createdAt: "2026-03-10T14:56:00Z",
      startedAt: "2026-03-10T14:56:01Z",
      completedAt: "2026-03-10T14:56:10Z",
      ...metaOverrides,
    },
    events,
    context: null,
    networkLogs: null,
  };
}

async function loadInspectData(data: InspectLogData): Promise<void> {
  const json = JSON.stringify({ meta: data.meta, events: data.events });
  const file = new File([json], "test.json", { type: "application/json" });
  await context.store.set(loadInspectLogFile$, file, context.signal);
}

describe("activityInspectPage", () => {
  describe("empty state", () => {
    // ACT-D-046
    it("upload JSON button opens file picker", async () => {
      detachedSetupPage({ context, path: "/activities/inspect" });

      await waitFor(() => {
        expect(screen.getByText("No log loaded")).toBeInTheDocument();
      });

      expect(screen.getByText("Upload JSON")).toBeInTheDocument();
      const fileInput = document.querySelector('input[type="file"]');
      expect(fileInput).not.toBeNull();
    });
  });

  describe("loaded data", () => {
    // ACT-D-032
    it("inspect log data renders", async () => {
      detachedSetupPage({ context, path: "/activities/inspect" });
      await loadInspectData(makeInspectData());

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "Test Inspect Agent" }),
        ).toBeInTheDocument();
      });
    });

    // ACT-D-033
    it("display name falls back to Imported Log", async () => {
      detachedSetupPage({ context, path: "/activities/inspect" });
      await loadInspectData(makeInspectData({ displayName: undefined }));

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "Imported Log" }),
        ).toBeInTheDocument();
      });
    });

    // ACT-D-034
    it("log status renders", async () => {
      detachedSetupPage({ context, path: "/activities/inspect" });
      await loadInspectData(makeInspectData({ status: "failed" }));

      await waitFor(() => {
        expect(screen.getByTestId("status-badge")).toHaveTextContent(/Failed/i);
      });
    });

    // ACT-D-035
    it("trigger source and agent name render", async () => {
      detachedSetupPage({ context, path: "/activities/inspect" });
      await loadInspectData(
        makeInspectData({
          triggerSource: "agent",
          triggerAgentName: "Parent Bot",
        }),
      );

      await waitFor(() => {
        expect(screen.getByText("Agent (Parent Bot)")).toBeInTheDocument();
      });
    });

    // ACT-D-036
    it("detail object properties render", async () => {
      detachedSetupPage({ context, path: "/activities/inspect" });
      await loadInspectData(makeInspectData({ framework: "claude-code" }));

      await waitFor(() => {
        const modelLabel = screen.getByText("Model");
        expect(modelLabel.parentElement).toHaveTextContent("claude-code");
      });
    });

    // ACT-D-037
    it("formatted duration and time render", async () => {
      detachedSetupPage({ context, path: "/activities/inspect" });
      await loadInspectData(
        makeInspectData({
          startedAt: "2026-03-10T14:56:01Z",
          completedAt: "2026-03-10T14:56:10Z",
          createdAt: "2026-03-10T14:56:00Z",
        }),
      );

      await waitFor(() => {
        expect(screen.getByText("9.0s")).toBeInTheDocument();
      });
      expect(screen.getByText(/\d{2}\/\d{2}/)).toBeInTheDocument();
    });

    // ACT-D-038
    it("events array renders", async () => {
      const testEvent: AgentEvent = {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text: "Hello from events" }],
          },
        },
        createdAt: "2026-03-10T14:56:02Z",
      };

      detachedSetupPage({ context, path: "/activities/inspect" });
      await loadInspectData(makeInspectData({}, [testEvent]));

      await waitFor(() => {
        expect(screen.getByText("Hello from events")).toBeInTheDocument();
      });
    });

    // ACT-D-039
    it("prompt and system prompt render", async () => {
      detachedSetupPage({ context, path: "/activities/inspect" });
      await loadInspectData(
        makeInspectData({
          prompt: "My test prompt",
          appendSystemPrompt: "My system prompt",
        }),
      );

      await waitFor(() => {
        expect(screen.getAllByText("My test prompt").length).toBeGreaterThan(0);
      });
      expect(screen.getAllByText("My system prompt").length).toBeGreaterThan(0);
    });

    // ACT-D-040
    it("step search term filters visible steps", async () => {
      const visibleEvent: AgentEvent = {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text: "Unique step content" }],
          },
        },
        createdAt: "2026-03-10T14:56:02Z",
      };

      detachedSetupPage({ context, path: "/activities/inspect" });
      await loadInspectData(makeInspectData({}, [visibleEvent]));

      await waitFor(() => {
        expect(screen.getByText("Unique step content")).toBeInTheDocument();
      });

      context.store.set(setInspectStepSearch$, "xyz-no-match");

      await waitFor(() => {
        expect(
          screen.queryByText("Unique step content"),
        ).not.toBeInTheDocument();
      });
    });

    // ACT-D-041
    it("message and visible message counts render", async () => {
      const visibleEvent: AgentEvent = {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text: "Step one text" }],
          },
        },
        createdAt: "2026-03-10T14:56:02Z",
      };

      detachedSetupPage({ context, path: "/activities/inspect" });
      await loadInspectData(makeInspectData({}, [visibleEvent]));

      await waitFor(() => {
        expect(screen.getByText("1 total")).toBeInTheDocument();
      });
    });
  });

  describe("tabs", () => {
    // ACT-D-042
    it("active tab selection renders", async () => {
      detachedSetupPage({
        context,
        path: "/activities/inspect",
        featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
      });
      await loadInspectData(makeInspectData());

      await waitFor(() => {
        expect(screen.getByPlaceholderText("Search steps")).toBeInTheDocument();
      });
    });

    // ACT-D-043
    it("context and network tabs are visible when showDebugTabs is enabled", async () => {
      detachedSetupPage({
        context,
        path: "/activities/inspect",
        featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
      });
      await loadInspectData(makeInspectData());

      await waitFor(() => {
        const tabs = screen.getAllByRole("tab");
        expect(
          tabs.some((el) => {
            return el.textContent?.trim() === "Steps";
          }),
        ).toBeTruthy();
        expect(
          tabs.some((el) => {
            return el.textContent?.trim() === "Context";
          }),
        ).toBeTruthy();
        expect(
          tabs.some((el) => {
            return el.textContent?.trim() === "Network";
          }),
        ).toBeTruthy();
      });
    });

    // ACT-D-044
    it("only Steps tab is visible when showDebugTabs is disabled", async () => {
      detachedSetupPage({ context, path: "/activities/inspect" });
      await loadInspectData(makeInspectData());

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "Test Inspect Agent" }),
        ).toBeInTheDocument();
      });

      expect(
        screen.queryAllByRole("tab").find((el) => {
          return el.textContent?.trim() === "Steps";
        }),
      ).toBeUndefined();
      expect(
        screen.queryAllByRole("tab").find((el) => {
          return el.textContent?.trim() === "Context";
        }),
      ).toBeUndefined();
      expect(
        screen.queryAllByRole("tab").find((el) => {
          return el.textContent?.trim() === "Network";
        }),
      ).toBeUndefined();
    });

    // ACT-D-048
    it("tab triggers switch content to context view", async () => {
      detachedSetupPage({
        context,
        path: "/activities/inspect",
        featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
      });
      await loadInspectData(makeInspectData());

      await waitFor(() => {
        expect(screen.getByPlaceholderText("Search steps")).toBeInTheDocument();
      });

      click(screen.getByText("Context"));

      await waitFor(() => {
        expect(
          screen.queryByPlaceholderText("Search steps"),
        ).not.toBeInTheDocument();
      });
    });
  });

  describe("interactions", () => {
    // ACT-D-045
    it("search input onChange updates inspectStepSearch$", async () => {
      const user = userEvent.setup();
      detachedSetupPage({ context, path: "/activities/inspect" });
      await loadInspectData(makeInspectData());

      await waitFor(() => {
        expect(screen.getByPlaceholderText("Search steps")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText("Search steps");
      await user.type(searchInput, "hello");

      expect(context.store.get(inspectStepSearch$)).toBe("hello");
    });

    // ACT-D-047
    it("file input loads JSON data", async () => {
      const user = userEvent.setup();
      detachedSetupPage({ context, path: "/activities/inspect" });

      await waitFor(() => {
        expect(screen.getByText("No log loaded")).toBeInTheDocument();
      });

      const data = {
        meta: {
          displayName: "Uploaded Agent",
          status: "completed",
          startedAt: "2026-03-10T14:56:01Z",
          completedAt: "2026-03-10T14:56:10Z",
        },
        events: [],
      };
      const file = new File([JSON.stringify(data)], "upload.json", {
        type: "application/json",
      });
      const input = document.querySelector(
        'input[type="file"]',
      ) as HTMLInputElement;

      await user.upload(input, file);

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "Uploaded Agent" }),
        ).toBeInTheDocument();
      });
    });
  });
});
