/**
 * Composer `/go ` slash-command parser, exercised through the real send
 * pipeline. The parser lives in `createSendMessage` and is gated by the
 * `Goal` feature switch — when the switch is off, the literal `/go ...`
 * text is sent through unchanged so the agent can still see it.
 *
 * Entry point: /chats/:id thread page
 * Mock (external): Web API via MSW (feature switch + send-body capture).
 * Real (internal): chat composer, send command, parseGoalCommand.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { chatMessagesContract } from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();
const mockApi = createMockApi(context);
const THREAD_ID = "thread-goal-test";

interface CapturedSendBody {
  prompt?: string;
  goal?: boolean;
}

function captureSendBody(): { current: CapturedSendBody | undefined } {
  const ref: { current: CapturedSendBody | undefined } = { current: undefined };
  server.use(
    mockApi(chatMessagesContract.send, ({ body, respond }) => {
      ref.current = body as CapturedSendBody;
      return respond(201, {
        runId: "run-goal-test",
        threadId: THREAD_ID,
        status: "pending",
        createdAt: "2026-05-10T00:00:00Z",
      });
    }),
  );
  return ref;
}

describe("chat composer — /go slash command", () => {
  beforeEach(() => {
    mockChatLifecycle({ threadId: THREAD_ID });
  });

  it("strips the /go prefix and sets goal=true when the feature switch is on", async () => {
    const user = userEvent.setup();
    setMockFeatureSwitches({ [FeatureSwitchKey.Goal]: true });

    const captured = captureSendBody();
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(
      user,
      textarea,
      "/go Migrate the auth middleware off the legacy session store",
    );

    await waitFor(() => {
      expect(captured.current).toBeDefined();
    });
    expect(captured.current?.goal).toBe(true);
    expect(captured.current?.prompt).toBe(
      "Migrate the auth middleware off the legacy session store",
    );
  });

  it("sends the literal /go text when the feature switch is off", async () => {
    const user = userEvent.setup();
    setMockFeatureSwitches({ [FeatureSwitchKey.Goal]: false });

    const captured = captureSendBody();
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "/go figure out the bug");

    await waitFor(() => {
      expect(captured.current).toBeDefined();
    });
    expect(captured.current?.goal).toBeUndefined();
    expect(captured.current?.prompt).toBe("/go figure out the bug");
  });

  it("does not treat /go alone (no objective) as a goal command", async () => {
    const user = userEvent.setup();
    setMockFeatureSwitches({ [FeatureSwitchKey.Goal]: true });

    const captured = captureSendBody();
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "/go");

    await waitFor(() => {
      expect(captured.current).toBeDefined();
    });
    expect(captured.current?.goal).toBeUndefined();
    expect(captured.current?.prompt).toBe("/go");
  });

  it("does not set goal=true for messages that don't start with /go", async () => {
    const user = userEvent.setup();
    setMockFeatureSwitches({ [FeatureSwitchKey.Goal]: true });

    const captured = captureSendBody();
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "How do I run /go from the CLI?");

    await waitFor(() => {
      expect(captured.current).toBeDefined();
    });
    expect(captured.current?.goal).toBeUndefined();
    expect(captured.current?.prompt).toBe("How do I run /go from the CLI?");
  });
});
