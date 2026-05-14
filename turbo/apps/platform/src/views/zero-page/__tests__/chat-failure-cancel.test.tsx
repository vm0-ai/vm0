import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  click,
  fill,
} from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();

describe("chat failure and cancel", () => {
  it("should display error message and restore Send button on failure", async () => {
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

    ctrl.failRun("Something went wrong");

    await waitFor(() => {
      expect(screen.getByText(/Something went wrong/)).toBeInTheDocument();
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).toBeNull();
    });
  });

  it("should send cancel request when Stop button is clicked", async () => {
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

    click(screen.getByLabelText("Stop"));
    ctrl.cancelRun();

    // After server confirms cancellation, sending state ends and Send button returns
    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).toBeNull();
    });
  });

  it("should restore input after cancel", async () => {
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

    ctrl.cancelRun();

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).toBeNull();
    });

    // Textarea should be enabled and accessible
    const restoredTextarea = screen.getByPlaceholderText(PLACEHOLDER);
    expect(restoredTextarea).not.toBeDisabled();
  });
});

const AGENT_PATH = "/agents/c0000000-0000-4000-a000-000000000001/chat";

describe("send vs stop button visibility during active run", () => {
  it("shows Stop button when running with empty input", async () => {
    const user = userEvent.setup();
    mockChatLifecycle();

    detachedSetupPage({
      context,
      path: AGENT_PATH,
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Hello");

    // Input cleared after send → Stop visible
    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(screen.queryByLabelText("Send")).toBeNull();
    });
  });

  it("shows Send button (not Stop) when running and input has content", async () => {
    const user = userEvent.setup();
    mockChatLifecycle();

    detachedSetupPage({
      context,
      path: AGENT_PATH,
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Hello");

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    const activeTextarea = await waitFor(() => {
      return screen.getByPlaceholderText(
        /Type your next message/,
      ) as HTMLTextAreaElement;
    });
    await fill(activeTextarea, "something to queue");

    // Input has content → Send replaces Stop
    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).toBeNull();
    });
  });

  it("clicking Send while running with content queues the message", async () => {
    const user = userEvent.setup();
    const appendedContents: (string | undefined)[] = [];
    mockChatLifecycle({
      onQueuedMessageAppend: (body) => {
        appendedContents.push(body.content);
      },
    });

    detachedSetupPage({
      context,
      path: AGENT_PATH,
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Hello");

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    const activeTextarea = await waitFor(() => {
      return screen.getByPlaceholderText(
        /Type your next message/,
      ) as HTMLTextAreaElement;
    });
    await fill(activeTextarea, "queued via button");

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Send"));

    await waitFor(() => {
      expect(appendedContents).toContain("queued via button");
    });
  });
});
