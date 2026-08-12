import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const THREAD_ID = "b0000000-0000-4000-a000-000000000903";
const RUN_ID = "run-active";
const CONTINUATION_PRESENTATION_ENABLED = {
  [FeatureSwitchKey.ChatRunContinuationPresentation]: true,
} as const;

type TranscriptLabel = `U${number}` | `A${number}`;

interface RunActionCase {
  readonly name: string;
  readonly sequence: readonly TranscriptLabel[];
  readonly unassociatedLabels: readonly TranscriptLabel[];
  readonly expectedActionBars: number;
  readonly actionOwner: TranscriptLabel | null;
  readonly steerLabels: readonly TranscriptLabel[];
}

const RUN_ACTION_CASES = [
  {
    name: "U1",
    sequence: ["U1"],
    unassociatedLabels: [],
    expectedActionBars: 0,
    actionOwner: null,
    steerLabels: [],
  },
  {
    name: "U1 A1 U2",
    sequence: ["U1", "A1", "U2"],
    unassociatedLabels: ["U2"],
    expectedActionBars: 0,
    actionOwner: null,
    steerLabels: ["U2"],
  },
  {
    name: "U1 U2",
    sequence: ["U1", "U2"],
    unassociatedLabels: ["U2"],
    expectedActionBars: 0,
    actionOwner: null,
    steerLabels: ["U2"],
  },
  {
    name: "U1 U2 A1",
    sequence: ["U1", "U2", "A1"],
    unassociatedLabels: [],
    expectedActionBars: 1,
    actionOwner: "A1",
    steerLabels: ["U2"],
  },
  {
    name: "U1 A1 U2 A2",
    sequence: ["U1", "A1", "U2", "A2"],
    unassociatedLabels: [],
    expectedActionBars: 1,
    actionOwner: "A2",
    steerLabels: ["U2"],
  },
] as const satisfies readonly RunActionCase[];

function transcriptEvent(
  label: TranscriptLabel,
  index: number,
  unassociatedLabels: readonly TranscriptLabel[],
): MockChatEventInput {
  return {
    id: `msg-${label.toLowerCase()}`,
    role: label.startsWith("U") ? "user" : "assistant",
    content: label,
    runId: unassociatedLabels.includes(label) ? undefined : RUN_ID,
    createdAt: new Date(Date.UTC(2026, 7, 11, 10, 0, index)).toISOString(),
  };
}

describe("chat run actions", () => {
  it.each(RUN_ACTION_CASES)(
    "$name shows actions only after the latest user message",
    async ({
      sequence,
      unassociatedLabels,
      expectedActionBars,
      actionOwner,
      steerLabels,
    }) => {
      mockChatLifecycle(context, {
        threadId: THREAD_ID,
        activeRunIds: [RUN_ID],
        chatEvents: sequence.map((label, index) => {
          return transcriptEvent(label, index, unassociatedLabels);
        }),
      });

      detachedSetupPage({
        context,
        path: `/chats/${THREAD_ID}`,
        featureSwitches: CONTINUATION_PRESENTATION_ENABLED,
      });

      await expect(
        screen.findByText(sequence.at(-1)!),
      ).resolves.toBeInTheDocument();

      const actionBars = await waitFor(() => {
        const rows = screen.queryAllByTestId("chat-event-actions");
        expect(rows).toHaveLength(expectedActionBars);
        return rows;
      });
      expect(screen.queryAllByTestId("chat-steer-indicator")).toHaveLength(
        steerLabels.length,
      );
      for (const label of steerLabels) {
        const steerMessage = screen
          .getByText(label)
          .closest<HTMLElement>('[data-role="user"]');
        expect(steerMessage).not.toBeNull();
        expect(
          within(steerMessage!).getByTestId("chat-steer-indicator"),
        ).toBeInTheDocument();
      }

      if (actionOwner === null) {
        return;
      }

      const ownerGroup = screen
        .getByText(actionOwner)
        .closest<HTMLElement>('[data-role="assistant"]');
      expect(ownerGroup).not.toBeNull();
      expect(
        within(ownerGroup!).getAllByTestId("chat-event-actions"),
      ).toStrictEqual(actionBars);
    },
  );

  it("explains a steer message when its indicator is hovered", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      activeRunIds: [RUN_ID],
      chatEvents: [
        transcriptEvent("U1", 0, []),
        transcriptEvent("U2", 1, ["U2"]),
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: CONTINUATION_PRESENTATION_ENABLED,
    });

    const indicator = await screen.findByTestId("chat-steer-indicator");
    expect(indicator).toHaveAccessibleName(
      "Sent while the agent was working to direct its behavior",
    );
    await user.hover(indicator);

    await expect(
      screen.findByText(
        "Sent while the agent was working to direct its behavior",
        { selector: "div" },
      ),
    ).resolves.toBeVisible();
  });

  it("keeps legacy actions and hides steer indicators when the feature switch is disabled", async () => {
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      activeRunIds: [RUN_ID],
      chatEvents: [
        transcriptEvent("U1", 0, []),
        transcriptEvent("A1", 1, []),
        transcriptEvent("U2", 2, ["U2"]),
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatRunContinuationPresentation]: false,
      },
    });

    await expect(screen.findByText("U2")).resolves.toBeInTheDocument();
    expect(screen.queryAllByTestId("chat-event-actions")).toHaveLength(1);
    expect(screen.queryByTestId("chat-steer-indicator")).toBeNull();
  });
});
