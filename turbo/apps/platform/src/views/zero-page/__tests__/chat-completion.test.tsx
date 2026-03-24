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

describe("chat completion", () => {
  it("should display final markdown content after completion", async () => {
    const ctrl = mockChatLifecycle();

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
        expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    ctrl.completeRun("Here is the **result**");

    await waitFor(
      () => {
        expect(screen.getByText("result")).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
  }, 30_000);

  it("should restore Send button and remove Stop button after completion", async () => {
    const ctrl = mockChatLifecycle();

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
        expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    ctrl.completeRun("Done");

    await waitFor(
      () => {
        expect(screen.getByLabelText("Send")).toBeInTheDocument();
        expect(screen.queryByLabelText("Stop")).toBeNull();
      },
      { timeout: 10_000 },
    );
  }, 30_000);

  it("should collapse activity steps into expandable timeline", async () => {
    const ctrl = mockChatLifecycle();

    await setupPage({ context, path: "/talk/zero" });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      { timeout: 5000 },
    );

    await act(() => {
      sendMessageInUI(textarea, "Hello");
    });

    // Wait for running state
    await waitFor(
      () => {
        const shimmer = document.querySelector(".zero-shimmer-text");
        expect(shimmer).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );

    // Add two activity events
    ctrl.setEvents([
      makeToolUseEvent("Bash", {}, 1),
      makeToolUseEvent("Read", {}, 2),
    ]);

    // Wait for activity steps to appear
    await waitFor(
      () => {
        expect(screen.getByText("Running a command...")).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );

    // Complete the run
    ctrl.completeRun("Done");

    // Wait for collapsed timeline
    await waitFor(
      () => {
        expect(screen.getByText(/Took \d+ steps?/)).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
  }, 30_000);

  it("should update sidebar title after completion", async () => {
    const ctrl = mockChatLifecycle();

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
        expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // Set thread list so the sidebar shows a preview after completion
    ctrl.setThreadList([
      {
        id: "thread-test-1",
        title: "My conversation",
        preview: "Hello",
        agentComposeId: "mock-compose-id",
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);

    ctrl.completeRun("Done");

    // The sidebar renders session.preview as the visible text
    await waitFor(
      () => {
        // Look for the sidebar preview text (not the user message bubble)
        const links = document.querySelectorAll("a");
        const sidebarLink = Array.from(links).find(
          (a) =>
            a.textContent === "Hello" &&
            a.getAttribute("href")?.includes("chat"),
        );
        expect(sidebarLink).toBeTruthy();
      },
      { timeout: 10_000 },
    );
  }, 30_000);
});
