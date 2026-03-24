import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent, act } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();

describe("chat failure and cancel", () => {
  it("should display error message and restore Send button on failure", async () => {
    const ctrl = mockChatLifecycle();

    await setupPage({ context, path: "/talk/mock-compose-id" });

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

    ctrl.failRun("Something went wrong");

    await waitFor(
      () => {
        expect(screen.getByText(/Something went wrong/)).toBeInTheDocument();
        expect(screen.getByLabelText("Send")).toBeInTheDocument();
        expect(screen.queryByLabelText("Stop")).toBeNull();
      },
      { timeout: 10_000 },
    );
  }, 30_000);

  it("should send cancel request when Stop button is clicked", async () => {
    mockChatLifecycle();

    await setupPage({ context, path: "/talk/mock-compose-id" });

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

    await act(() => {
      fireEvent.click(screen.getByLabelText("Stop"));
    });

    // After clicking Stop, the sending state ends and Send button returns
    await waitFor(
      () => {
        expect(screen.getByLabelText("Send")).toBeInTheDocument();
        expect(screen.queryByLabelText("Stop")).toBeNull();
      },
      { timeout: 10_000 },
    );
  }, 30_000);

  it("should show cancelled state after polling discovers cancellation", async () => {
    const ctrl = mockChatLifecycle();

    await setupPage({ context, path: "/talk/mock-compose-id" });

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

    ctrl.cancelRun();

    await waitFor(
      () => {
        // After polling discovers cancellation, the run error is set
        expect(screen.getByText(/cancelled/i)).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
  }, 30_000);

  it("should restore input after cancel", async () => {
    const ctrl = mockChatLifecycle();

    await setupPage({ context, path: "/talk/mock-compose-id" });

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

    ctrl.cancelRun();

    await waitFor(
      () => {
        expect(screen.getByLabelText("Send")).toBeInTheDocument();
        expect(screen.queryByLabelText("Stop")).toBeNull();
      },
      { timeout: 10_000 },
    );

    // Textarea should be enabled and accessible
    const restoredTextarea = screen.getByPlaceholderText(PLACEHOLDER);
    expect(restoredTextarea).not.toBeDisabled();
  }, 30_000);
});
