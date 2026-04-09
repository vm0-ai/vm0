import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
  makeToolUseEvent,
} from "./chat-test-helpers.ts";

const context = testContext();

describe("chat queue state", () => {
  it("should show queue position when run is queued", async () => {
    const user = userEvent.setup();
    const ctrl = mockChatLifecycle();

    ctrl.setRunStatus("queued");
    ctrl.setQueuePosition(3);

    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "Hello");

    await waitFor(() => {
      expect(screen.getByText(/In queue/)).toBeInTheDocument();
    });

    // Complete the run and wait for polling to stop
    ctrl.completeRun();
    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
  });

  it("should transition from queue to running state", async () => {
    const user = userEvent.setup();
    const ctrl = mockChatLifecycle();
    ctrl.setRunStatus("queued");
    ctrl.setQueuePosition(2);

    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "Hello");

    // Wait for queue state
    await waitFor(() => {
      expect(screen.getByText(/In queue/)).toBeInTheDocument();
    });

    // Transition to running with events
    ctrl.setRunStatus("running");
    ctrl.setEvents([makeToolUseEvent("Search")]);

    await waitFor(() => {
      expect(screen.queryByText(/In queue/)).toBeNull();
      expect(screen.getByText("Searching for info...")).toBeInTheDocument();
    });

    // Complete the run and wait for polling to stop
    ctrl.completeRun();
    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
  });
});
