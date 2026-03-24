import { describe, expect, it } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
  makeToolUseEvent,
} from "./chat-test-helpers.ts";

const context = testContext();

describe("chat queue state", () => {
  it("should show queue position when run is queued", async () => {
    const ctrl = mockChatLifecycle();
    // Set status to queued before the first poll
    ctrl.setRunStatus("queued");
    ctrl.setQueuePosition(3);

    await setupPage({ context, path: "/talk/zero" });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      { timeout: 5000 },
    );

    await act(() => {
      sendMessageInUI(textarea, "Hello");
    });

    await waitFor(
      () => {
        expect(screen.getByText(/In queue/)).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );

    // Complete the run and wait for polling to stop
    ctrl.completeRun();
    await waitFor(
      () => {
        expect(screen.getByLabelText("Send")).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
  }, 30_000);

  it("should transition from queue to running state", async () => {
    const ctrl = mockChatLifecycle();
    ctrl.setRunStatus("queued");
    ctrl.setQueuePosition(2);

    await setupPage({ context, path: "/talk/zero" });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      { timeout: 5000 },
    );

    await act(() => {
      sendMessageInUI(textarea, "Hello");
    });

    // Wait for queue state
    await waitFor(
      () => {
        expect(screen.getByText(/In queue/)).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );

    // Transition to running with events
    ctrl.setRunStatus("running");
    ctrl.setEvents([makeToolUseEvent("Search")]);

    await waitFor(
      () => {
        expect(screen.queryByText(/In queue/)).toBeNull();
        expect(screen.getByText("Searching for info...")).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );

    // Complete the run and wait for polling to stop
    ctrl.completeRun();
    await waitFor(
      () => {
        expect(screen.getByLabelText("Send")).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
  }, 30_000);
});
