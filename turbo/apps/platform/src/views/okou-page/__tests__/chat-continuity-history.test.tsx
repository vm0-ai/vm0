import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  chatEventsContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test } from "vitest";

import { fill, setupPage } from "../../../__tests__/page-helper.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { fastButton } from "./chat-list-test-helpers.ts";
import {
  continuityEventRow,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();

interface CapturedSend {
  readonly clientEventId: string;
  readonly threadId: string;
  readonly userMessage: UserMessageDocument;
}

function textDocument(text: string): UserMessageDocument {
  return { version: 1, parts: [{ type: "text", text }] };
}

function promptRow(
  caseId: number,
  sequence: number,
  threadId: string,
  text: string,
  options: {
    readonly id?: string;
    readonly runId?: string;
    readonly runGroupId?: string;
    readonly revokesEventId?: string;
    readonly userMessage?: UserMessageDocument;
  } = {},
): ChatEventRow {
  const row = continuityEventRow(caseId, sequence, threadId, "input.prompt", {
    payload: { userMessage: options.userMessage ?? textDocument(text) },
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.runGroupId === undefined
      ? {}
      : { runGroupId: options.runGroupId }),
    ...(options.revokesEventId === undefined
      ? {}
      : { revokesEventId: options.revokesEventId }),
  });
  return options.id === undefined ? row : { ...row, id: options.id };
}

function outputRow(
  caseId: number,
  sequence: number,
  threadId: string,
  text: string,
  run: { readonly id: string; readonly groupId?: string },
): ChatEventRow {
  return continuityEventRow(caseId, sequence, threadId, "output.message", {
    payload: { content: text },
    runId: run.id,
    ...(run.groupId === undefined ? {} : { runGroupId: run.groupId }),
  });
}

function completedRow(
  caseId: number,
  sequence: number,
  threadId: string,
  runId: string,
): ChatEventRow {
  return continuityEventRow(caseId, sequence, threadId, "run.completed", {
    runId,
  });
}

function threadContainer(threadId: string): HTMLElement {
  const container = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${threadId}"]`,
  );
  if (!container) {
    throw new Error(`Expected chat pane ${threadId}`);
  }
  return container;
}

function scrollContainer(threadId: string): HTMLElement {
  const scroller = threadContainer(threadId).querySelector<HTMLElement>(
    "[data-scroll-container]",
  );
  if (!scroller) {
    throw new Error(`Expected scroll container for ${threadId}`);
  }
  return scroller;
}

function setScrollableGeometry(
  scroller: HTMLElement,
  scrollHeight: number,
  clientHeight: number,
): void {
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: scrollHeight },
    clientHeight: { configurable: true, value: clientHeight },
  });
}

function eventAnchorCount(container: ParentNode, eventId: string): number {
  return container.querySelectorAll(
    `[data-chat-scroll-anchor-event-id="${eventId}"]`,
  ).length;
}

function userTurnCount(container: ParentNode, text: string): number {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-role="user"]'),
  ).filter((turn) => {
    return turn.textContent?.includes(text) === true;
  }).length;
}

function queuedMessage(container: ParentNode): HTMLElement | undefined {
  return (
    container.querySelector<HTMLElement>(
      '[role="listitem"][aria-label="Queued message"]',
    ) ?? undefined
  );
}

test("Load a long chat history without losing grouped-run context", async () => {
  const thread = continuityThread(20, 1, "Long grouped history");
  const rows: ChatEventRow[] = [];
  let sequence = 1;
  const addPair = (
    prompt: string,
    response: string,
    runId: string,
    runGroupId?: string,
    userMessage?: UserMessageDocument,
  ): { readonly prompt: ChatEventRow; readonly response: ChatEventRow } => {
    const promptEvent = promptRow(20, sequence++, thread.id, prompt, {
      runId,
      ...(runGroupId === undefined ? {} : { runGroupId }),
      ...(userMessage === undefined ? {} : { userMessage }),
    });
    const responseEvent = outputRow(20, sequence++, thread.id, response, {
      id: runId,
      ...(runGroupId === undefined ? {} : { groupId: runGroupId }),
    });
    rows.push(promptEvent, responseEvent);
    return { prompt: promptEvent, response: responseEvent };
  };

  const earliest = addPair(
    "Earliest retained request",
    "Earliest retained answer",
    "history-run-earliest",
  );
  addPair("Older planning request", "Older planning answer", "history-run-2");
  addPair("Earlier review request", "Earlier review answer", "history-run-3");
  const beforeGroup = addPair(
    "Context before repeated work",
    "Neighboring answer before repeated work",
    "history-run-before-group",
  );
  const runGroupId = "launch-brief-group";
  addPair(
    "Build the launch brief from these references",
    "First hidden launch brief result",
    "history-group-run-1",
    runGroupId,
  );
  addPair(
    "Build the launch brief from these references",
    "Second hidden launch brief result",
    "history-group-run-2",
    runGroupId,
  );
  const latestGrouped = addPair(
    "Build the launch brief from these references",
    "Final launch brief is ready",
    "history-group-run-3",
    runGroupId,
    {
      version: 1,
      parts: [
        {
          type: "text",
          text: "Build the launch brief from these references",
        },
        {
          type: "file",
          fileId: "f8000000-0000-4000-a000-000000020001",
          filenameSnapshot: "launch-evidence.pdf",
          contentType: "application/pdf",
        },
      ],
    },
  );
  const afterGroup = addPair(
    "Review the final launch brief",
    "Neighboring answer after repeated work",
    "history-run-after-group",
  );
  addPair("Most recent follow-up", "Most recent answer", "history-run-recent");

  const workspace = await installContinuityWorkspace(context, {
    caseId: 20,
    threads: [thread],
    chatEventRows: rows,
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    auth: workspace.auth,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  const container = threadContainer(thread.id);
  await waitFor(() => {
    expect(container).toHaveTextContent("Final launch brief is ready");
    expect(container).toHaveTextContent(
      "Neighboring answer before repeated work",
    );
    expect(container).toHaveTextContent(
      "Neighboring answer after repeated work",
    );
    expect(container).toHaveTextContent("launch-evidence.pdf");
  });
  expect(composer).toBeVisible();
  expect(container).not.toHaveTextContent("First hidden launch brief result");
  expect(container).not.toHaveTextContent("Second hidden launch brief result");
  expect(container).not.toHaveTextContent("Earliest retained request");

  const folds = container.querySelectorAll("[data-chat-run-group-fold]");
  expect(folds).toHaveLength(1);
  const foldButton = folds[0]?.querySelector("button");
  expect(foldButton).toHaveAttribute("aria-expanded", "false");
  expect(foldButton).toHaveTextContent(
    "2 runs for Build the launch brief from these references",
  );
  expect(eventAnchorCount(container, latestGrouped.response.id)).toBe(1);

  const scroller = scrollContainer(thread.id);
  setScrollableGeometry(scroller, 2400, 600);
  scroller.scrollTop = 50;
  fireEvent.scroll(scroller);

  await waitFor(() => {
    expect(container).toHaveTextContent("Earliest retained request");
    expect(container).toHaveTextContent("Earliest retained answer");
  });
  expect(eventAnchorCount(container, earliest.prompt.id)).toBe(1);
  expect(eventAnchorCount(container, beforeGroup.prompt.id)).toBe(1);
  expect(eventAnchorCount(container, afterGroup.response.id)).toBe(1);
  expect(container.querySelectorAll("[data-chat-run-group-fold]")).toHaveLength(
    1,
  );
});

test("Navigate chat history with scroll controls and keyboard commands", async () => {
  const thread = continuityThread(21, 1, "Scrollable conversation");
  const rows: ChatEventRow[] = [];
  for (let index = 1; index <= 6; index++) {
    const runId = `scroll-run-${index.toString()}`;
    rows.push(
      promptRow(21, index * 2 - 1, thread.id, `History request ${index}`, {
        runId,
      }),
      outputRow(21, index * 2, thread.id, `History answer ${index}`, {
        id: runId,
      }),
    );
  }
  const workspace = await installContinuityWorkspace(context, {
    caseId: 21,
    threads: [thread],
    chatEventRows: rows,
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    auth: workspace.auth,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  const container = threadContainer(thread.id);
  await waitFor(() => {
    expect(container).toHaveTextContent("History answer 6");
  });
  const scroller = scrollContainer(thread.id);
  setScrollableGeometry(scroller, 2400, 600);
  scroller.scrollTop = 2400;

  scroller.scrollTop = 800;
  fireEvent.scroll(scroller);
  await waitFor(() => {
    expect(container.querySelector("[data-scroll-to-bottom]")).toBeVisible();
  });

  await userEvent.click(fastButton("Scroll to bottom", container));
  await waitFor(() => {
    expect(scroller.scrollTop).toBe(2400);
    expect(container.querySelector("[data-scroll-to-bottom]")).toBeNull();
  });
  expect(container).toHaveTextContent("History answer 6");

  container.focus();
  await userEvent.keyboard("{Control>}{ArrowUp}{/Control}");
  await waitFor(() => {
    expect(scroller.scrollTop).toBe(0);
    expect(container.querySelector("[data-scroll-to-bottom]")).toBeVisible();
  });

  composer.focus();
  await userEvent.keyboard("{Control>}{ArrowDown}{/Control}");
  await waitFor(() => {
    expect(scroller.scrollTop).toBe(2400);
    expect(container.querySelector("[data-scroll-to-bottom]")).toBeNull();
  });

  await fill(composer, "Arrow remains available while editing");
  const bottomOffset = scroller.scrollTop;
  await userEvent.keyboard("{ArrowUp}");
  expect(composer).toHaveTextContent("Arrow remains available while editing");
  expect(scroller.scrollTop).toBe(bottomOffset);
});

test("Keep open chats live without duplicating messages", async () => {
  const main = continuityThread(22, 1, "Live main conversation");
  const side = continuityThread(22, 2, "Live side conversation");
  const initialMainRunId = "b9000000-0000-4000-a000-000000000001";
  const activeMainRunId = "b9000000-0000-4000-a000-000000000002";
  const sideRunId = "b9000000-0000-4000-a000-000000000003";
  const initialMainRows = [
    promptRow(22, 1, main.id, "Existing main request", {
      runId: initialMainRunId,
    }),
    outputRow(22, 2, main.id, "Existing main answer", {
      id: initialMainRunId,
    }),
    completedRow(22, 3, main.id, initialMainRunId),
  ];
  const initialSideRows = [
    promptRow(22, 1, side.id, "Existing side request", { runId: sideRunId }),
    outputRow(22, 2, side.id, "Existing side answer", { id: sideRunId }),
  ];
  let allRows = [...initialMainRows, ...initialSideRows];
  const workspace = await installContinuityWorkspace(context, {
    caseId: 22,
    threads: [main, side],
    chatEventRows: allRows,
  });
  const sends: CapturedSend[] = [];
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if (
      !("userMessage" in body) ||
      body.userMessage === undefined ||
      body.clientEventId === undefined ||
      body.threadId === undefined
    ) {
      throw new Error("Expected a normal chat message send");
    }
    sends.push({
      clientEventId: body.clientEventId,
      threadId: body.threadId,
      userMessage: body.userMessage,
    });
    return respond(201, {
      runId: sends.length === 1 ? activeMainRunId : null,
      threadId: body.threadId,
    });
  });

  await setupPage({
    context,
    path: `/chats/${main.id}?sidebar=${side.id}`,
    auth: workspace.auth,
  });

  await waitFor(() => {
    expect(
      threadContainer(main.id).querySelector(
        '[role="textbox"][aria-label="Message"]',
      ),
    ).toBeVisible();
    expect(
      threadContainer(side.id).querySelector(
        '[role="textbox"][aria-label="Message"]',
      ),
    ).toBeVisible();
    expect(threadContainer(side.id)).toBeVisible();
    expect(threadContainer(main.id)).toHaveTextContent("Existing main answer");
    expect(threadContainer(side.id)).toHaveTextContent("Existing side answer");
    expect(
      context.mocks.ably.hasSubscription(`chatThreadDetailChanged:${main.id}`),
    ).toBeTruthy();
    expect(
      context.mocks.ably.hasSubscription(`chatThreadDetailChanged:${side.id}`),
    ).toBeTruthy();
  });

  const sideReply = outputRow(
    22,
    3,
    side.id,
    "A live reply for the side conversation",
    { id: sideRunId },
  );
  allRows = [...allRows, sideReply];
  workspace.setChatEventRows(allRows);
  createChatEvent(side.id);

  await waitFor(() => {
    expect(threadContainer(side.id)).toHaveTextContent(
      "A live reply for the side conversation",
    );
  });
  expect(threadContainer(main.id)).not.toHaveTextContent(
    "A live reply for the side conversation",
  );

  const mainContainer = threadContainer(main.id);
  const mainComposer = mainContainer.querySelector<HTMLElement>(
    '[role="textbox"][aria-label="Message"]',
  );
  if (!mainComposer) {
    throw new Error("Expected main composer");
  }
  await fill(mainComposer, "Send this exactly once");
  await userEvent.click(fastButton("Send", mainContainer));
  await waitFor(() => {
    expect(sends).toHaveLength(1);
    expect(userTurnCount(mainContainer, "Send this exactly once")).toBe(1);
  });
  const sent = sends[0]!;
  expect(sent.threadId).toBe(main.id);

  const acceptedMessageId = "a9000000-0000-4000-a000-000000022001";
  const confirmedRows = [
    promptRow(22, 4, main.id, "Send this exactly once", {
      id: sent.clientEventId,
      userMessage: sent.userMessage,
    }),
    promptRow(22, 5, main.id, "Send this exactly once", {
      id: acceptedMessageId,
      runId: activeMainRunId,
      revokesEventId: sent.clientEventId,
      userMessage: sent.userMessage,
    }),
    outputRow(22, 6, main.id, "Assistant output after confirmation", {
      id: activeMainRunId,
    }),
  ];
  allRows = [...allRows, ...confirmedRows];
  workspace.setChatEventRows(allRows);
  createChatEvent(main.id);

  await waitFor(() => {
    expect(mainContainer).toHaveTextContent(
      "Assistant output after confirmation",
    );
    expect(userTurnCount(mainContainer, "Send this exactly once")).toBe(1);
    expect(eventAnchorCount(mainContainer, acceptedMessageId)).toBe(1);
  });
  expect(eventAnchorCount(mainContainer, sent.clientEventId)).toBe(0);

  await fill(mainComposer, "Steer this active run once");
  await waitFor(() => {
    expect(fastButton("Send", mainContainer)).toBeEnabled();
  });
  await userEvent.click(fastButton("Send", mainContainer));
  await waitFor(() => {
    expect(sends).toHaveLength(2);
  });
  const steering = sends[1]!;
  const deliveredSteeringId = "a9000000-0000-4000-a000-000000022002";
  const steeringRows = [
    promptRow(22, 7, main.id, "Steer this active run once", {
      id: steering.clientEventId,
      userMessage: steering.userMessage,
    }),
    promptRow(22, 8, main.id, "Steer this active run once", {
      id: deliveredSteeringId,
      runId: activeMainRunId,
      revokesEventId: steering.clientEventId,
      userMessage: steering.userMessage,
    }),
    outputRow(22, 9, main.id, "Assistant acknowledged the steering message", {
      id: activeMainRunId,
    }),
  ];
  allRows = [...allRows, ...steeringRows];
  workspace.setChatEventRows(allRows);
  createChatEvent(main.id);

  await waitFor(() => {
    expect(mainContainer).toHaveTextContent(
      "Assistant acknowledged the steering message",
    );
    expect(userTurnCount(mainContainer, "Steer this active run once")).toBe(1);
    expect(eventAnchorCount(mainContainer, deliveredSteeringId)).toBe(1);
    expect(queuedMessage(mainContainer)).toBeUndefined();
  });
  expect(eventAnchorCount(mainContainer, steering.clientEventId)).toBe(0);
  expect(threadContainer(main.id)).toBeVisible();
  expect(threadContainer(side.id)).toBeVisible();
});
