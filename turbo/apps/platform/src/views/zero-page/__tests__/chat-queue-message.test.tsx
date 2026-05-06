import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();

const THREAD_ID = "thread-test-1";
const CHAT_PATH = `/chats/${THREAD_ID}`;

function getActiveRunTextarea(): Promise<HTMLTextAreaElement> {
  return waitFor(() => {
    return screen.getByPlaceholderText(
      /Type your next message/,
    ) as HTMLTextAreaElement;
  });
}

async function startActiveRun(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLTextAreaElement> {
  const textarea = await waitFor(() => {
    return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
  });

  await sendMessageInUI(user, textarea, "start the active run");

  await waitFor(() => {
    expect(screen.getByLabelText("Stop")).toBeInTheDocument();
  });

  return await getActiveRunTextarea();
}

describe("chat pending message queue", () => {
  it("queues keyboard sends during an active run when enabled", async () => {
    const user = userEvent.setup({ delay: null });
    const appendedContents: (string | undefined)[] = [];
    mockChatLifecycle({
      onPendingMessageAppend: (body) => {
        appendedContents.push(body.content);
      },
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: true },
    });

    let textarea = await startActiveRun(user);
    await fill(textarea, "first pending");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toBeInTheDocument();
      expect(screen.getByText("first pending")).toBeInTheDocument();
    });
    expect(textarea).toHaveClass("min-h-[116px]");
    expect(textarea.value).toBe("");

    textarea = await getActiveRunTextarea();
    await fill(textarea, "second pending");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(
        screen.getByText((_content, element) => {
          return element?.textContent === "first pending\n\nsecond pending";
        }),
      ).toBeInTheDocument();
    });
    expect(appendedContents).toStrictEqual(["first pending", "second pending"]);
  });

  it("does not queue keyboard sends while the feature switch is disabled", async () => {
    const user = userEvent.setup({ delay: null });
    let appendCount = 0;
    mockChatLifecycle({
      onPendingMessageAppend: () => {
        appendCount++;
      },
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
      featureSwitches: { [FeatureSwitchKey.QueueMessage]: false },
    });

    const textarea = await startActiveRun(user);
    await fill(textarea, "should stay in the composer");
    await user.keyboard("{Enter}");

    expect(appendCount).toBe(0);
    expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
    expect(textarea.value).toBe("should stay in the composer");
  });
});
