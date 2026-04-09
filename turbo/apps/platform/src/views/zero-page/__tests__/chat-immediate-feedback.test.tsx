import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  zeroChatMessages$,
  allFinished$,
  sendExistingThreadMessage$,
} from "../../../signals/chat-page/chat-message.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();

describe("chat immediate feedback after sending", () => {
  it("should produce a placeholder assistant message while waiting for server response", async () => {
    let resolvePost!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolvePost = resolve;
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

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
    });

    // Send message — prepareUserMessage$ runs before the POST, so the user
    // message is added to internalLocalMessages$ immediately.
    const sendPromise = context.store.set(
      sendExistingThreadMessage$,
      "Hello",
      context.signal,
    );

    // zeroChatMessages$ should include user + derived placeholder assistant
    await vi.waitFor(async () => {
      const messages = await context.store.get(zeroChatMessages$);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
    });

    // The placeholder assistant message should have a finished$ that never
    // resolves (neverResolve$), which keeps allFinished$ pending.  Verify by
    // inspecting the placeholder's runLoop.finished$ directly — its promise
    // status must still be "pending".
    const messages = await context.store.get(zeroChatMessages$);
    const placeholder = messages.find((m) => {
      return m.role === "assistant";
    });
    expect(placeholder).toBeDefined();
    expect(placeholder!.role).toBe("assistant");
    const assistantMsg =
      placeholder as import("../../../signals/chat-page/chat-message.ts").AssistantChatMessage;
    expect(assistantMsg.runLoop).toBeDefined();
    // The finished$ promise should be pending (never-resolving).
    // We verify this by racing it against an immediately-resolved value.
    const finishedStatus = await Promise.race([
      context.store.get(assistantMsg.runLoop!.finished$).then(() => {
        return "resolved" as const;
      }),
      Promise.resolve("pending" as const),
    ]);
    expect(finishedStatus).toBe("pending");

    // Release the POST and complete the run so the send command finishes
    resolvePost();
    ctrl.completeRun();
    await sendPromise;

    await vi.waitFor(async () => {
      const f = await context.store.get(allFinished$);
      expect(f).toBeTruthy();
    });
  });

  it("should show thinking indicator and disable Send button immediately after submission", async () => {
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

    // With the placeholder fix, sending state and thinking indicator
    // should be visible even before the POST responds.
    // With mutual exclusion ternary, Stop button replaces Send while sending.
    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(screen.queryByLabelText("Send")).not.toBeInTheDocument();
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
