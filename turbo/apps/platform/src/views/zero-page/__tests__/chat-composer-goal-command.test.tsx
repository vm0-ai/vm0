/**
 * Composer Send-as-goal dropdown, exercised through the real send pipeline.
 * The dropdown is gated by the `Goal` feature switch — when off the regular
 * Send button is rendered without a chevron and there's no path to goal mode.
 *
 * Entry point: /chats/:id thread page
 * Mock (external): Web API via MSW (feature switch + send-body capture).
 * Real (internal): chat composer, Send dropdown, send command.
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

// `aria-label` is not in textContent so the cheap text-based finders won't
// see icon-only buttons. querySelector on the attribute is the project's
// accepted workaround (mirrors the pattern in zero-chat-thread-page-display
// tests).
function findSendButton(): HTMLButtonElement | null {
  return document.querySelector('button[aria-label="Send"]');
}
function findDropdownTrigger(): HTMLButtonElement | null {
  return document.querySelector('button[aria-label="More send options"]');
}
function findGoalMenuItem(): HTMLElement | null {
  const items = document.querySelectorAll<HTMLElement>('[role="menuitem"]');
  for (const item of items) {
    if (/Send as goal/i.test(item.textContent ?? "")) {
      return item;
    }
  }
  return null;
}

describe("chat composer — Send-as-goal dropdown", () => {
  beforeEach(() => {
    mockChatLifecycle({ threadId: THREAD_ID });
  });

  it("hides the dropdown chevron when the Goal feature switch is off", async () => {
    setMockFeatureSwitches({ [FeatureSwitchKey.Goal]: false });
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      ).toBeInTheDocument();
    });

    expect(findSendButton()).not.toBeNull();
    expect(findDropdownTrigger()).toBeNull();
  });

  it("shows the dropdown chevron when the Goal feature switch is on", async () => {
    setMockFeatureSwitches({ [FeatureSwitchKey.Goal]: true });
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      ).toBeInTheDocument();
    });

    expect(findSendButton()).not.toBeNull();
    expect(findDropdownTrigger()).not.toBeNull();
  });

  it("clicking 'Send as goal' sends the draft with goal=true", async () => {
    const user = userEvent.setup();
    setMockFeatureSwitches({ [FeatureSwitchKey.Goal]: true });

    const captured = captureSendBody();
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await user.type(
      textarea,
      "Migrate the auth middleware off the legacy session store",
    );

    const trigger = await waitFor(() => {
      const t = findDropdownTrigger();
      if (!t) {
        throw new Error("dropdown trigger not rendered");
      }
      return t;
    });
    await user.click(trigger);

    const goalItem = await waitFor(() => {
      const item = findGoalMenuItem();
      if (!item) {
        throw new Error("Send as goal menu item not rendered");
      }
      return item;
    });
    await user.click(goalItem);

    await waitFor(() => {
      expect(captured.current).toBeDefined();
    });
    expect(captured.current?.goal).toBeTruthy();
    expect(captured.current?.prompt).toBe(
      "Migrate the auth middleware off the legacy session store",
    );
  });

  it("clicking the regular Send button does not set goal=true", async () => {
    const user = userEvent.setup();
    setMockFeatureSwitches({ [FeatureSwitchKey.Goal]: true });

    const captured = captureSendBody();
    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "Just a regular question");

    await waitFor(() => {
      expect(captured.current).toBeDefined();
    });
    expect(captured.current?.goal).toBeUndefined();
    expect(captured.current?.prompt).toBe("Just a regular question");
  });
});
