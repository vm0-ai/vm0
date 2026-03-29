import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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

    await setupPage({ context, path: "/talk/mock-compose-id" });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    sendMessageInUI(textarea, "Hello");

    await waitFor(() => {
      expect(screen.getByText("Hello")).toBeInTheDocument();
    });

    // Complete the run and wait for polling to stop
    ctrl.completeRun();
    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
  });

  it("should show Stop button and hide Send button while sending", async () => {
    const ctrl = mockChatLifecycle();

    await setupPage({ context, path: "/talk/mock-compose-id" });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    sendMessageInUI(textarea, "Hello");

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      // While sending, the Send button is disabled
      expect(screen.getByLabelText("Send")).toBeDisabled();
    });

    ctrl.completeRun("Done");

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });

    expect(screen.queryByLabelText("Stop")).toBeNull();
  });

  it("should display thinking text while waiting for telemetry", async () => {
    const ctrl = mockChatLifecycle();

    await setupPage({ context, path: "/talk/mock-compose-id" });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    sendMessageInUI(textarea, "Hello");

    // The thinking message cycles through various texts; the shimmer class
    // is applied to the element. We check for the shimmer class presence.
    await waitFor(() => {
      const shimmer = document.querySelector(".zero-shimmer-text");
      expect(shimmer).toBeInTheDocument();
    });

    // Complete the run and wait for polling to stop
    ctrl.completeRun();
    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
  });

  it("should replace thinking with activity steps when telemetry arrives", async () => {
    const ctrl = mockChatLifecycle();

    await setupPage({ context, path: "/talk/mock-compose-id" });

    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    sendMessageInUI(textarea, "Hello");

    // Wait for thinking state
    await waitFor(() => {
      const shimmer = document.querySelector(".zero-shimmer-text");
      expect(shimmer).toBeInTheDocument();
    });

    // Add telemetry events
    ctrl.setEvents([makeToolUseEvent("Bash")]);

    // Wait for activity step to appear
    await waitFor(() => {
      expect(screen.getByText("Running a command...")).toBeInTheDocument();
    });

    // Complete the run and wait for polling to stop
    ctrl.completeRun();
    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
  });
});
