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

describe("chat completion", () => {
  it("should display final markdown content after completion", async () => {
    const user = userEvent.setup();
    const ctrl = mockChatLifecycle();

    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "Hello");

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    ctrl.completeRun("Here is the **result**");

    await waitFor(() => {
      expect(screen.getByText("result")).toBeInTheDocument();
    });
  });

  it("should restore Send button and remove Stop button after completion", async () => {
    const user = userEvent.setup();
    const ctrl = mockChatLifecycle();

    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "Hello");

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    ctrl.completeRun("Done");

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).toBeNull();
    });
  });

  it("should collapse activity steps into expandable timeline", async () => {
    const user = userEvent.setup();
    const ctrl = mockChatLifecycle();

    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "Hello");

    // Wait for running state
    await waitFor(() => {
      const shimmer = document.querySelector(".zero-shimmer-text");
      expect(shimmer).toBeInTheDocument();
    });

    // Add two activity events
    ctrl.setEvents([
      makeToolUseEvent("Bash", {}, 1),
      makeToolUseEvent("Read", {}, 2),
    ]);

    // Wait for activity steps to appear
    await waitFor(() => {
      expect(screen.getByText("Running a command...")).toBeInTheDocument();
    });

    // Complete the run
    ctrl.completeRun("Done");

    // Wait for collapsed timeline
    await waitFor(() => {
      expect(screen.getByText(/Took \d+ steps?/)).toBeInTheDocument();
    });
  });

  it("should update sidebar title after completion", async () => {
    const user = userEvent.setup();
    const ctrl = mockChatLifecycle();
    ctrl.setThreadList([
      {
        id: "thread-test-1",
        title: "untitled",
        agentId: "c0000000-0000-4000-a000-000000000001",
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);

    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "Hello");

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    // Set thread list so the sidebar shows a title after completion
    ctrl.setThreadList([
      {
        id: "thread-test-1",
        title: "My conversation",
        agentId: "c0000000-0000-4000-a000-000000000001",
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);

    ctrl.completeRun("Done");

    // The sidebar renders session.title as the visible text
    await waitFor(() => {
      // Look for the sidebar title text (not the user message bubble)
      const links = document.querySelectorAll("a");
      const sidebarLink = Array.from(links).find((a) => {
        return (
          a.textContent === "My conversation" &&
          a.getAttribute("href")?.includes("chat")
        );
      });
      expect(sidebarLink).toBeTruthy();
    });
  });
});
