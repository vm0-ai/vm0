import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
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
});
