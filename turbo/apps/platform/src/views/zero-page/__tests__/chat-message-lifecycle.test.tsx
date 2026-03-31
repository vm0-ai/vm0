import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();

describe("chat message lifecycle", () => {
  it("should show user message and assistant response after sending", async () => {
    const user = userEvent.setup();
    const ctrl = mockChatLifecycle();

    await setupPage({
      context,
      path: "/talk/c0000000-0000-4000-a000-000000000001",
    });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    await sendMessageInUI(user, textarea, "What can you do?");

    // User message appears
    await waitFor(() => {
      expect(screen.getByText("What can you do?")).toBeInTheDocument();
    });

    // Assistant thinking indicator appears
    await waitFor(() => {
      const shimmer = document.querySelector(".zero-shimmer-text");
      expect(shimmer).toBeInTheDocument();
    });

    ctrl.completeRun("I can help with many things!");

    // Assistant response replaces thinking
    await waitFor(() => {
      expect(
        screen.getByText("I can help with many things!"),
      ).toBeInTheDocument();
    });
  });

  it("should stay on talk page when run creation fails", async () => {
    const user = userEvent.setup();
    mockChatLifecycle();
    server.use(
      http.post("*/api/zero/chat/messages", () =>
        HttpResponse.json(
          { error: { message: "Some API error", code: "BAD_REQUEST" } },
          { status: 400 },
        ),
      ),
    );

    await setupPage({
      context,
      path: "/talk/c0000000-0000-4000-a000-000000000001",
    });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    await sendMessageInUI(user, textarea, "Hello");

    // User stays on /talk/ — the composer is still available for retry
    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });
  });

  it("should stay on talk page when message sending fails", async () => {
    const user = userEvent.setup();
    mockChatLifecycle();
    server.use(
      http.post("*/api/zero/chat/messages", () =>
        HttpResponse.json(
          {
            error: {
              message: "Internal server error",
              code: "INTERNAL_SERVER_ERROR",
            },
          },
          { status: 500 },
        ),
      ),
    );

    await setupPage({
      context,
      path: "/talk/c0000000-0000-4000-a000-000000000001",
    });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    await sendMessageInUI(user, textarea, "Hello");

    // User stays on /talk/ — the composer is still available for retry
    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });
  });

  it("should not send empty messages", async () => {
    const user = userEvent.setup();
    mockChatLifecycle();

    await setupPage({
      context,
      path: "/talk/c0000000-0000-4000-a000-000000000001",
    });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    await sendMessageInUI(user, textarea, "   ");

    // Empty message is ignored — user stays on /talk/ with composer available
    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });
  });
});
