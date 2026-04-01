import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  zeroChatMessages$,
  allFinished$,
  sendExistingThreadMessage$,
} from "../../../signals/zero-page/zero-chat.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();

describe("chat immediate feedback after sending", () => {
  it("should produce a placeholder assistant message while waiting for server response", async () => {
    // Signal-level test: use withoutRender to avoid page setup race condition
    let resolvePost!: () => void;
    const gate = new Promise<void>((r) => {
      resolvePost = r;
    });

    const ctrl = mockChatLifecycle();

    // Override POST AFTER mockChatLifecycle so our handler takes precedence
    server.use(
      http.post("*/api/zero/chat/messages", async () => {
        await gate;
        return HttpResponse.json(
          {
            runId: "run-test-1",
            threadId: "thread-test-1",
            status: "pending",
            createdAt: "2026-03-10T00:00:00Z",
          },
          { status: 201 },
        );
      }),
    );

    await setupPage({
      context,
      path: "/chat/thread-test-1",
      withoutRender: true,
    });

    // Send message — prepareUserMessage$ runs before the POST, so the user
    // message is added to internalLocalMessages$ immediately.
    const sendPromise = context.store.set(
      sendExistingThreadMessage$,
      "Hello",
      undefined,
      context.signal,
    );

    // zeroChatMessages$ should include user + derived placeholder assistant
    await vi.waitFor(async () => {
      const messages = await context.store.get(zeroChatMessages$);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
    });

    // allFinished$ should NOT resolve (placeholder's finished$ never resolves)
    const raced = await Promise.race([
      context.store.get(allFinished$).then(() => "resolved" as const),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 500)),
    ]);
    expect(raced).toBe("pending");

    // Release the POST and complete the run so the send command finishes
    resolvePost();
    ctrl.completeRun();
    await sendPromise;

    await vi.waitFor(async () => {
      const f = await context.store.get(allFinished$);
      expect(f).toBe(true);
    });
  });

  it("should show thinking indicator and disable Send button immediately after submission", async () => {
    const user = userEvent.setup();
    const ctrl = mockChatLifecycle();

    await setupPage({
      context,
      path: "/talk/c0000000-0000-4000-a000-000000000001",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "Hello");

    // With the placeholder fix, sending state and thinking indicator
    // should be visible even before the POST responds.
    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeDisabled();
    });

    await waitFor(() => {
      const shimmer = document.querySelector(".zero-shimmer-text");
      expect(shimmer).toBeInTheDocument();
    });

    ctrl.completeRun();
    await waitFor(() => {
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    });
  });
});
