import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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
    const ctrl = mockChatLifecycle();

    await setupPage({
      context,
      path: "/talk/c0000000-0000-4000-a000-000000000001",
    });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    await sendMessageInUI(textarea, "What can you do?");

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

  it("should not send empty messages", async () => {
    mockChatLifecycle();

    await setupPage({
      context,
      path: "/talk/c0000000-0000-4000-a000-000000000001",
    });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    await sendMessageInUI(textarea, "   ");

    // Empty message is ignored — user stays on /talk/ with composer available
    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });
  });
});
