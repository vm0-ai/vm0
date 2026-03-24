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

describe("chat sending state", () => {
  it("should show user message and clear input after send", async () => {
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
        expect(screen.getByText("Hello")).toBeInTheDocument();
      },
      { timeout: 5000 },
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

  it("should show Stop button and hide Send button while sending", async () => {
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

    // While sending, the Send button label changes to "Queue message"
    expect(screen.queryByLabelText("Send")).toBeNull();

    ctrl.completeRun("Done");

    await waitFor(
      () => {
        expect(screen.getByLabelText("Send")).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );

    expect(screen.queryByLabelText("Stop")).toBeNull();
  }, 30_000);

  it("should display thinking text while waiting for telemetry", async () => {
    const ctrl = mockChatLifecycle();

    await setupPage({ context, path: "/talk/zero" });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      { timeout: 5000 },
    );

    await act(() => {
      sendMessageInUI(textarea, "Hello");
    });

    // The thinking message cycles through various texts; the shimmer class
    // is applied to the element. We check for the shimmer class presence.
    await waitFor(
      () => {
        const shimmer = document.querySelector(".zero-shimmer-text");
        expect(shimmer).toBeInTheDocument();
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

  it("should replace thinking with activity steps when telemetry arrives", async () => {
    const ctrl = mockChatLifecycle();

    await setupPage({ context, path: "/talk/zero" });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      { timeout: 5000 },
    );

    await act(() => {
      sendMessageInUI(textarea, "Hello");
    });

    // Wait for thinking state
    await waitFor(
      () => {
        const shimmer = document.querySelector(".zero-shimmer-text");
        expect(shimmer).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );

    // Add telemetry events
    ctrl.setEvents([makeToolUseEvent("Bash")]);

    // Wait for activity step to appear
    await waitFor(
      () => {
        expect(screen.getByText("Running a command...")).toBeInTheDocument();
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
