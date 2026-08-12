import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { i18n } from "../../../i18n/index.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { mockChatLifecycle, sendQueuedMessage } from "./chat-test-helpers.ts";

const context = testContext();

const THREAD_ID = "b0000000-0000-4000-a000-000000000903";
const RUN_ID = "run-active";
const CONTINUATION_PRESENTATION_ENABLED = {
  [FeatureSwitchKey.ChatRunContinuationPresentation]: true,
} as const;
const STEER_ONE_COPY = "Picked this up mid-run — earlier work kept";
const STEER_TWO_COPY = "All 2 messages picked up mid-run — earlier work kept";

type TranscriptLabel = `U${number}` | `A${number}`;

interface RunActionCase {
  readonly name: string;
  readonly sequence: readonly TranscriptLabel[];
  readonly unassociatedLabels: readonly TranscriptLabel[];
  readonly expectedActionBars: number;
  readonly actionOwner: TranscriptLabel | null;
  /** One acknowledgement per burst of consecutive steers, labelled by count. */
  readonly steerAcknowledgements: readonly string[];
}

const RUN_ACTION_CASES = [
  {
    name: "U1",
    sequence: ["U1"],
    unassociatedLabels: [],
    expectedActionBars: 0,
    actionOwner: null,
    steerAcknowledgements: [],
  },
  {
    name: "U1 A1 U2",
    sequence: ["U1", "A1", "U2"],
    unassociatedLabels: ["U2"],
    expectedActionBars: 0,
    actionOwner: null,
    steerAcknowledgements: [STEER_ONE_COPY],
  },
  {
    name: "U1 U2",
    sequence: ["U1", "U2"],
    unassociatedLabels: ["U2"],
    expectedActionBars: 0,
    actionOwner: null,
    steerAcknowledgements: [STEER_ONE_COPY],
  },
  {
    name: "U1 U2 U3",
    sequence: ["U1", "U2", "U3"],
    unassociatedLabels: ["U2", "U3"],
    expectedActionBars: 0,
    actionOwner: null,
    steerAcknowledgements: [STEER_TWO_COPY],
  },
  {
    name: "U1 U2 A1",
    sequence: ["U1", "U2", "A1"],
    unassociatedLabels: [],
    expectedActionBars: 1,
    actionOwner: "A1",
    steerAcknowledgements: [STEER_ONE_COPY],
  },
  {
    name: "U1 A1 U2 A2",
    sequence: ["U1", "A1", "U2", "A2"],
    unassociatedLabels: [],
    expectedActionBars: 1,
    actionOwner: "A2",
    steerAcknowledgements: [STEER_ONE_COPY],
  },
] as const satisfies readonly RunActionCase[];

afterEach(async () => {
  await i18n.changeLanguage("en-US");
  document.documentElement.lang = "en-US";
});

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
      steerAcknowledgements,
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
      const acknowledgements = screen.queryAllByTestId(
        "chat-steer-acknowledgement",
      );
      expect(
        acknowledgements.map((element) => {
          return element.textContent;
        }),
      ).toStrictEqual(steerAcknowledgements);

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

  it("acknowledges a steer without waiting for a hover", async () => {
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

    await expect(
      screen.findByTestId("chat-steer-acknowledgement"),
    ).resolves.toBeVisible();
    await expect(screen.findByText(STEER_ONE_COPY)).resolves.toBeVisible();
  });

  it("acknowledges a burst of steers once, counting every message", async () => {
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      activeRunIds: [RUN_ID],
      chatEvents: [
        transcriptEvent("U1", 0, []),
        transcriptEvent("U2", 1, ["U2", "U3", "U4"]),
        transcriptEvent("U3", 2, ["U2", "U3", "U4"]),
        transcriptEvent("U4", 3, ["U2", "U3", "U4"]),
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: CONTINUATION_PRESENTATION_ENABLED,
    });

    await expect(screen.findByText("U4")).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryAllByTestId("chat-steer-acknowledgement"),
      ).toHaveLength(1);
    });
    await expect(
      screen.findByText("All 3 messages picked up mid-run — earlier work kept"),
    ).resolves.toBeVisible();
  });

  it("acknowledges each burst separately when Zero answers in between", async () => {
    // Reconciled steers carry the run id, so the transcript keeps them in
    // arrival order and Zero's reply genuinely separates the two bursts.
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      activeRunIds: [RUN_ID],
      chatEvents: [
        transcriptEvent("U1", 0, []),
        transcriptEvent("U2", 1, []),
        transcriptEvent("U3", 2, []),
        transcriptEvent("A1", 3, []),
        transcriptEvent("U4", 4, []),
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: CONTINUATION_PRESENTATION_ENABLED,
    });

    await expect(screen.findByText("U4")).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryAllByTestId("chat-steer-acknowledgement").map((element) => {
          return element.textContent;
        }),
      ).toStrictEqual([STEER_TWO_COPY, STEER_ONE_COPY]);
    });
  });

  it("counts up the acknowledgement in place as more steers arrive", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      activeRunIds: [RUN_ID],
      chatEvents: [transcriptEvent("U1", 0, []), transcriptEvent("A1", 1, [])],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: CONTINUATION_PRESENTATION_ENABLED,
    });

    await expect(screen.findByText("A1")).resolves.toBeInTheDocument();

    await sendQueuedMessage(user, "First steer");
    await expect(screen.findByText(STEER_ONE_COPY)).resolves.toBeVisible();

    await sendQueuedMessage(user, "Second steer");
    await expect(screen.findByText(STEER_TWO_COPY)).resolves.toBeVisible();

    // Still one acknowledgement for the burst, and the wording it replaced is
    // on screen being erased rather than having disappeared outright.
    const acknowledgements = screen.getAllByTestId(
      "chat-steer-acknowledgement",
    );
    expect(acknowledgements).toHaveLength(1);
    expect(
      acknowledgements[0]?.querySelector(
        "[data-steer-acknowledgement-outgoing]",
      )?.textContent,
    ).toBe(STEER_ONE_COPY);
  });

  it("keeps legacy actions and hides the acknowledgement when the feature switch is disabled", async () => {
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
    expect(screen.queryByTestId("chat-steer-acknowledgement")).toBeNull();
  });
});
