import { chatEventRowsResponse } from "../../../signals/__tests__/test-helpers.ts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  chatThreadEventsContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { IMAGE_RECOGNITION_MAX_FILE_BYTES } from "@okouai/api-contracts/contracts/image-recognition";
import { eventDrivenChatThread } from "../../../signals/chat-page/chat-thread-event-sourcing.ts";
import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import {
  fillComposer,
  mockChatLifecycle,
  PLACEHOLDER,
  sendMessageInUI,
} from "./chat-test-helpers.ts";
import {
  context,
  detachedSetupPage,
  AGENT_ID,
  COMPLETED_MARKER_ONLY_THREAD_ID,
  AGENT_CHAT_PATH,
  mockPushBrowserSupport,
  expectTextBefore,
  linkByText,
  chatScrollContainer,
  chatComposerTextarea,
  parseChatClipboardPayload,
  readClipboardItemText,
  readSingleRichClipboardWrite,
} from "./chat-lifecycle-test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";

interface TouchPoint {
  readonly x: number;
  readonly y: number;
}

function dispatchTouch(
  target: Element,
  type: "touchstart" | "touchmove",
  point: TouchPoint,
): Event {
  const event = new Event(type, {
    bubbles: true,
    cancelable: type === "touchmove",
  });
  Object.defineProperty(event, "touches", {
    configurable: true,
    value: [{ clientX: point.x, clientY: point.y }],
  });
  target.dispatchEvent(event);
  return event;
}

function openSoftwareKeyboard(): void {
  document.documentElement.dataset.keyboardOpen = "true";
  context.signal.addEventListener(
    "abort",
    () => {
      delete document.documentElement.dataset.keyboardOpen;
    },
    { once: true },
  );
}

function makeVerticallyScrollable(
  element: HTMLElement,
  {
    clientHeight,
    scrollHeight,
    scrollTop,
  }: {
    readonly clientHeight: number;
    readonly scrollHeight: number;
    readonly scrollTop: number;
  },
): void {
  element.style.overflowY = "auto";
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight },
    scrollTop: { configurable: true, value: scrollTop, writable: true },
  });
}

async function setupKeyboardGestureChat({
  standalone,
  threadId,
}: {
  readonly standalone: boolean;
  readonly threadId: string;
}): Promise<{
  readonly composerEditor: HTMLElement;
  readonly composerScrollSurface: HTMLElement;
  readonly history: HTMLElement;
}> {
  context.mocks.browser.standaloneDisplayMode(standalone);
  mockChatLifecycle(context, {
    threadId,
    chatEvents: [
      {
        id: `message-${threadId}`,
        role: "assistant",
        runId: `run-${threadId}`,
        content: "Existing thread",
        createdAt: "2026-07-30T00:00:00Z",
      },
    ],
  });
  detachedSetupPage({
    context,
    path: `/chats/${threadId}`,
  });

  return await waitFor(() => {
    const composerEditor = chatComposerTextarea();
    const history = chatScrollContainer();
    const composer = composerEditor.closest("[data-chat-composer]");
    const composerScrollSurface = composer?.children.item(1);
    if (!(composerScrollSurface instanceof HTMLElement)) {
      throw new Error("Chat composer scroll surface not found");
    }
    return { composerEditor, composerScrollSurface, history };
  });
}

function mockThreadEventRows({
  destinationThreadId,
  sourceEvents,
  destinationEvents,
  destinationInitialGate,
}: {
  readonly destinationThreadId: string;
  readonly sourceEvents: readonly MockChatEventInput[];
  readonly destinationEvents: readonly MockChatEventInput[];
  readonly destinationInitialGate?: Promise<void>;
}): void {
  context.mocks.api(
    chatThreadEventsContract.rows,
    async ({ params, query, respond }) => {
      if (
        params.threadId === destinationThreadId &&
        query.sinceSeqId === 0 &&
        destinationInitialGate
      ) {
        await destinationInitialGate;
      }
      const events =
        params.threadId === destinationThreadId
          ? destinationEvents
          : sourceEvents;
      return respond(
        200,
        chatEventRowsResponse(
          mockChatEventRows(
            normalizeMockChatEvents(
              events.map((event) => {
                return { ...event, threadId: params.threadId };
              }),
            ),
          ).filter((row) => {
            return row.seqId > query.sinceSeqId;
          }),
          query,
        ),
      );
    },
  );
}

const THREAD_ISOLATION_SOURCE_ID = "b0000000-0000-4000-a000-000000000901";
const THREAD_ISOLATION_DESTINATION_ID = "b0000000-0000-4000-a000-000000000902";

function threadIsolationSourceEvents(): MockChatEventInput[] {
  return [
    {
      id: "msg-existing-user",
      seqId: 1,
      role: "user",
      runId: "run-existing",
      content: "Existing context",
      createdAt: "2026-03-10T00:00:00Z",
    },
    {
      id: "msg-existing-assistant",
      seqId: 2,
      role: "assistant",
      runId: "run-existing",
      content: "Existing assistant answer",
      createdAt: "2026-03-10T00:00:01Z",
    },
    {
      id: "msg-existing-completed",
      seqId: 3,
      role: "assistant",
      runId: "run-existing",
      runLifecycleEvent: "completed",
      content: null,
      createdAt: "2026-03-10T00:00:02Z",
    },
  ];
}

function threadIsolationDestinationEvents(): MockChatEventInput[] {
  return [
    {
      id: "msg-other-user",
      seqId: 1,
      role: "user",
      runId: "run-other",
      content: "Other thread context",
      createdAt: "2026-03-10T00:00:00Z",
    },
    {
      id: "msg-other-assistant",
      seqId: 2,
      role: "assistant",
      runId: "run-other",
      content: "Other thread answer",
      createdAt: "2026-03-10T00:00:01Z",
    },
    {
      id: "msg-other-completed",
      seqId: 3,
      role: "assistant",
      runId: "run-other",
      runLifecycleEvent: "completed",
      content: null,
      createdAt: "2026-03-10T00:00:02Z",
    },
  ];
}

function threadIsolationList() {
  return [
    {
      id: THREAD_ISOLATION_SOURCE_ID,
      title: "Long thread",
      agent: { id: AGENT_ID, avatarUrl: null },
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:01Z",
    },
    {
      id: THREAD_ISOLATION_DESTINATION_ID,
      title: "Other thread",
      agent: { id: AGENT_ID, avatarUrl: null },
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
    },
  ];
}

describe("chat lifecycle", () => {
  it("links Slack-origin user messages back to the original message", async () => {
    const threadId = "e6000000-0000-4000-a000-000000000001";
    const permalink =
      "https://vm0.slack.com/archives/C12345678/p1753257600000100";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-slack-origin",
          role: "user",
          content: "Check the production rollout",
          runId: "run-slack-origin",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Check the production rollout" },
              { type: "source", kind: "slack", href: permalink },
            ],
          },
          createdAt: "2026-07-23T01:00:00Z",
        },
        {
          id: "msg-slack-origin-assistant",
          role: "assistant",
          content: "The rollout is healthy.",
          runId: "run-slack-origin",
          createdAt: "2026-07-23T01:01:00Z",
        },
        {
          id: "msg-slack-origin-without-link",
          role: "user",
          content: "This source link was unavailable",
          runId: "run-slack-origin-without-link",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "This source link was unavailable" },
              { type: "source", kind: "slack" },
            ],
          },
          createdAt: "2026-07-23T01:02:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText("Open message")).toBeInTheDocument();
    });
    const originLinks = queryAllByRoleFast("link").filter((link) => {
      return (
        link.getAttribute("aria-label") === "Open original message in Slack"
      );
    });
    const originLink = originLinks[0];
    expect(originLink).toBeDefined();
    expect(originLink).toHaveAttribute("href", permalink);
    expect(originLink).toHaveAttribute("target", "_blank");
    expect(originLink).toHaveTextContent("Slack");
    expect(originLink).toHaveTextContent("Open message");
    expect(originLinks).toHaveLength(1);
    expect(screen.getAllByText("Slack")).toHaveLength(2);
  });

  it("links Feishu-origin user messages back to the original chat", async () => {
    const threadId = "e6000000-0000-4000-a000-000000000002";
    const chatOpenUrl =
      "https://applink.feishu.cn/client/chat/open?openChatId=oc_feishu_chat";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-feishu-origin",
          role: "user",
          content: "Check the Feishu conversation",
          runId: "run-feishu-origin",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Check the Feishu conversation" },
              { type: "source", kind: "feishu", href: chatOpenUrl },
            ],
          },
          createdAt: "2026-07-23T01:00:00Z",
        },
        {
          id: "msg-feishu-origin-assistant",
          role: "assistant",
          content: "The conversation is available.",
          runId: "run-feishu-origin",
          createdAt: "2026-07-23T01:01:00Z",
        },
        {
          id: "msg-feishu-origin-without-link",
          role: "user",
          content: "This source link was unavailable",
          runId: "run-feishu-origin-without-link",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "This source link was unavailable" },
              { type: "source", kind: "feishu" },
            ],
          },
          createdAt: "2026-07-23T01:02:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText("Open chat")).toBeInTheDocument();
    });
    const originLinks = queryAllByRoleFast("link").filter((link) => {
      return link.getAttribute("aria-label") === "Open original chat in Feishu";
    });
    const originLink = originLinks[0];
    expect(originLink).toBeDefined();
    expect(originLink).toHaveAttribute("href", chatOpenUrl);
    expect(originLink).toHaveAttribute("target", "_blank");
    expect(originLink).toHaveTextContent("Feishu");
    expect(originLink).toHaveTextContent("Open chat");
    expect(originLinks).toHaveLength(1);
    expect(screen.getAllByText("Feishu")).toHaveLength(2);
  });

  it("renders generic source annotations with precise link behavior", async () => {
    const threadId = "e6000000-0000-4000-a000-000000000003";
    const teamsHref =
      "https://teams.microsoft.com/l/message/19%3Achannel%40thread.tacv2/activity-1?tenantId=tenant-1";
    const githubHref =
      "https://github.com/vm0-ai/vm0/issues/24218#issuecomment-123";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-teams-annotation",
          role: "user",
          content: "Teams source",
          runId: "run-teams-annotation",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Teams source" },
              { type: "source", kind: "teams", href: teamsHref },
            ],
          },
          createdAt: "2026-07-23T01:00:00Z",
        },
        {
          id: "msg-telegram-annotation",
          role: "user",
          content: "Telegram source",
          runId: "run-telegram-annotation",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Telegram source" },
              { type: "source", kind: "telegram" },
            ],
          },
          createdAt: "2026-07-23T01:01:00Z",
        },
        {
          id: "msg-github-annotation",
          role: "user",
          content: "GitHub source",
          runId: "run-github-annotation",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "GitHub source" },
              { type: "source", kind: "github", href: githubHref },
            ],
          },
          createdAt: "2026-07-23T01:02:00Z",
        },
        {
          id: "msg-agentphone-annotation",
          role: "user",
          content: "AgentPhone source",
          runId: "run-agentphone-annotation",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "AgentPhone source" },
              { type: "source", kind: "agentphone" },
            ],
          },
          createdAt: "2026-07-23T01:03:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText("Telegram")).toBeInTheDocument();
    });
    const annotationLinks = queryAllByRoleFast("link");
    const teamsLink = annotationLinks.find((link) => {
      return (
        link.getAttribute("aria-label") ===
        "Open original message in Microsoft Teams"
      );
    });
    expect(teamsLink).toBeDefined();
    expect(teamsLink).toHaveAttribute("href", teamsHref);
    expect(teamsLink).toHaveTextContent("Microsoft Teams");
    const githubLink = annotationLinks.find((link) => {
      return (
        link.getAttribute("aria-label") ===
        "Open original issue or pull request in GitHub"
      );
    });
    expect(githubLink).toBeDefined();
    expect(githubLink).toHaveAttribute("href", githubHref);
    expect(githubLink).toHaveTextContent("GitHub");
    expect(
      annotationLinks.find((link) => {
        return (
          link.getAttribute("aria-label") ===
          "Open original message in Telegram"
        );
      }),
    ).toBeUndefined();
    expect(screen.getByText("AgentPhone").closest("a")).toBeNull();
  });

  it("keeps an existing thread composer in its footer while idle and working", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000990";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "message-pwa-keyboard-layout",
          role: "assistant",
          runId: "run-pwa-keyboard-layout",
          content: "Existing thread",
          createdAt: "2026-07-15T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const composer = await waitFor(() => {
      return chatComposerTextarea();
    });
    const composerCard = composer.closest(".zero-composer");
    expect(composerCard).not.toBeNull();
    const composerFooter = composerCard?.closest("[data-chat-composer]");
    expect(composerFooter).not.toBeNull();
    expect(composerFooter).toHaveStyle({
      paddingBottom: "max(0.5rem - var(--sab), 0px)",
    });

    await sendMessageInUI(user, composer, "Continue working");

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      const workingComposer = chatComposerTextarea();
      const workingComposerCard = workingComposer.closest(".zero-composer");
      expect(workingComposerCard).not.toBeNull();
      expect(
        workingComposerCard?.closest("[data-chat-composer]"),
      ).not.toBeNull();
    });
  });

  it("contains keyboard gestures on the rendered standalone-PWA chat page", async () => {
    const { composerEditor, composerScrollSurface, history } =
      await setupKeyboardGestureChat({
        standalone: true,
        threadId: "b0000000-0000-4000-a000-000000000991",
      });

    expect(history).toHaveClass("overscroll-contain");
    expect(composerScrollSurface).toHaveClass("overscroll-contain");
    openSoftwareKeyboard();

    composerEditor.focus();
    dispatchTouch(composerEditor, "touchstart", { x: 100, y: 500 });
    const upwardMove = dispatchTouch(composerEditor, "touchmove", {
      x: 100,
      y: 460,
    });
    expect(upwardMove.defaultPrevented).toBeTruthy();
    expect(composerEditor).toHaveFocus();

    dispatchTouch(composerEditor, "touchstart", { x: 100, y: 500 });
    const composerDismissMove = dispatchTouch(composerEditor, "touchmove", {
      x: 100,
      y: 540,
    });
    expect(composerDismissMove.defaultPrevented).toBeTruthy();
    expect(composerEditor).not.toHaveFocus();

    composerEditor.focus();
    dispatchTouch(history, "touchstart", { x: 100, y: 200 });
    const historyMove = dispatchTouch(history, "touchmove", {
      x: 102,
      y: 240,
    });
    expect(historyMove.defaultPrevented).toBeFalsy();
    expect(composerEditor).not.toHaveFocus();

    makeVerticallyScrollable(composerEditor, {
      clientHeight: 80,
      scrollHeight: 300,
      scrollTop: 100,
    });
    composerEditor.focus();
    dispatchTouch(composerEditor, "touchstart", { x: 100, y: 500 });
    const draftScrollMove = dispatchTouch(composerEditor, "touchmove", {
      x: 100,
      y: 540,
    });
    expect(draftScrollMove.defaultPrevented).toBeFalsy();
    expect(composerEditor).toHaveFocus();
  });

  it("leaves mobile-browser chat gestures unchanged outside standalone mode", async () => {
    const { composerEditor, composerScrollSurface, history } =
      await setupKeyboardGestureChat({
        standalone: false,
        threadId: "b0000000-0000-4000-a000-000000000992",
      });

    expect(history).not.toHaveClass("overscroll-contain");
    expect(composerScrollSurface).not.toHaveClass("overscroll-contain");
    openSoftwareKeyboard();
    composerEditor.focus();
    dispatchTouch(composerEditor, "touchstart", { x: 100, y: 500 });
    const move = dispatchTouch(composerEditor, "touchmove", {
      x: 100,
      y: 460,
    });
    expect(move.defaultPrevented).toBeFalsy();
    expect(composerEditor).toHaveFocus();
  });

  it("subscribes the browser for push notifications after a visible chat send", async () => {
    const user = userEvent.setup({ delay: null });
    const pushBrowser = mockPushBrowserSupport();
    let capturedSubscription: unknown;
    context.mocks.http.post("*/api/push-subscriptions", async ({ request }) => {
      capturedSubscription = await request.json();
      return new Response(null, { status: 204 });
    });
    mockChatLifecycle(context);

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

    await waitFor(() => {
      expect(pushBrowser.register).toHaveBeenCalledWith("/sw.js", {
        updateViaCache: "none",
      });
    });
    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Notify me when this run finishes");

    await waitFor(() => {
      expect(
        screen.getByText("Notify me when this run finishes"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(capturedSubscription).toStrictEqual({
        endpoint: "https://push.example.test/subscriptions/chat-send",
        keys: {
          p256dh: "AQID",
          auth: "BAUG",
        },
      });
    });
  });

  it("starts a new fallback-enabled text-only chat with an image above the direct recognition limit", async () => {
    const user = userEvent.setup({ delay: null });
    let sentUserMessage: UserMessageDocument | undefined;
    context.mocks.data.userModelPreference({
      selectedModel: "deepseek-v4-flash",
      serviceTier: null,
      updatedAt: "2026-03-10T00:00:00Z",
    });
    context.mocks.data.orgModelPolicies([
      {
        id: "00000000-0000-4000-a000-000000000719",
        model: "deepseek-v4-flash",
        modelLabel: "DeepSeek V4 Flash",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
        routeStatus: "valid",
        routeStatusReason: null,
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
    ]);
    mockChatLifecycle(context, {
      onRunCreate: (body) => {
        sentUserMessage = body.userMessage;
      },
    });
    context.mocks.upload.success({
      id: "upload-visual-brief",
      filename: "brief.png",
      contentType: "image/png",
      size: IMAGE_RECOGNITION_MAX_FILE_BYTES + 1,
      url: "https://cdn.vm7.io/artifacts/test/upload-visual-brief/brief.png",
    });

    detachedSetupPage({
      context,
      path: AGENT_CHAT_PATH,
    });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) {
      throw new Error("file input not found");
    }

    const brief = new File(["image"], "brief.png", { type: "image/png" });
    Object.defineProperty(brief, "size", {
      configurable: true,
      value: IMAGE_RECOGNITION_MAX_FILE_BYTES + 1,
    });
    await user.upload(fileInput, brief);

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "DeepSeek V4 Flash" }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Remove brief.png")).toBeInTheDocument();
    });
    await screen.findByLabelText("Send");

    const textarea = screen.getByPlaceholderText(PLACEHOLDER);
    await sendMessageInUI(user, textarea, "Summarize this visual brief");

    await waitFor(() => {
      expect(
        screen.getByText("Summarize this visual brief"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(sentUserMessage?.parts).toContainEqual({
        type: "file",
        fileId: "upload-visual-brief",
        filenameSnapshot: "brief.png",
        contentType: "image/png",
      });
    });
  });

  it("sends a video attachment in an existing fallback-enabled text-only chat", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000994";
    let sentUserMessage: UserMessageDocument | undefined;
    context.mocks.data.userModelPreference({
      selectedModel: "deepseek-v4-flash",
      serviceTier: null,
      updatedAt: "2026-03-10T00:00:00Z",
    });
    context.mocks.data.orgModelPolicies([
      {
        id: "00000000-0000-4000-a000-000000000720",
        model: "deepseek-v4-flash",
        modelLabel: "DeepSeek V4 Flash",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
        routeStatus: "valid",
        routeStatusReason: null,
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
    ]);
    mockChatLifecycle(context, {
      threadId,
      selectedModel: "deepseek-v4-flash",
      onRunCreate: (body) => {
        sentUserMessage = body.userMessage;
      },
    });
    context.mocks.upload.success({
      id: "upload-existing-visual",
      filename: "existing.mov",
      contentType: "video/quicktime",
      size: 64,
      url: "https://cdn.vm7.io/artifacts/test/upload-existing-visual/existing.mov",
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) {
      throw new Error("file input not found");
    }
    await user.upload(
      fileInput,
      new File([new Uint8Array(64)], "existing.mov", {
        type: "video/quicktime",
      }),
    );

    await expect(
      screen.findByLabelText("Remove existing.mov"),
    ).resolves.toBeInTheDocument();

    await sendMessageInUI(user, textarea, "Inspect this existing video");

    await waitFor(() => {
      expect(sentUserMessage?.parts).toContainEqual({
        type: "file",
        fileId: "upload-existing-visual",
        filenameSnapshot: "existing.mov",
        contentType: "video/quicktime",
      });
    });
  });

  it("projects the first-run model from the optimistic created event", async () => {
    const user = userEvent.setup({ delay: null });
    const clipboard = context.mocks.browser.clipboardWrite();
    const prompt = "Start with my preferred model";
    const sendGate = context.mocks.deferred<void>();
    let clientThreadId: string | undefined;
    let sentUserMessage: UserMessageDocument | undefined;
    context.mocks.data.userModelPreference({
      selectedModel: "claude-sonnet-4-6",
      serviceTier: null,
      updatedAt: "2026-03-10T00:00:00Z",
    });
    context.mocks.data.orgModelPolicies([
      {
        id: "00000000-0000-4000-a000-000000000720",
        model: "claude-sonnet-4-6",
        modelLabel: "Claude Sonnet 4.6",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        modelProviderId: null,
        routeStatus: "valid",
        routeStatusReason: null,
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
      },
    ]);
    mockChatLifecycle(context, {
      sendGate: sendGate.promise,
      onThreadCreate: (body) => {
        clientThreadId = body.clientThreadId;
        expect(body.modelSelection.selectedModel).toBe("claude-sonnet-4-6");
      },
      onSendRequest: ({ userMessage }) => {
        sentUserMessage = userMessage;
      },
    });

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, prompt);

    await waitFor(() => {
      expect(clientThreadId).toBeDefined();
    });
    if (!clientThreadId) {
      throw new Error("Expected client thread id to be captured");
    }

    expect(
      context.store.get(eventDrivenChatThread(clientThreadId)),
    ).toMatchObject({
      selectedModel: "claude-sonnet-4-6",
    });

    await waitFor(() => {
      expect(screen.getByText(prompt)).toBeInTheDocument();
      expect(screen.getByLabelText("Copy message")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Copy message"));
    const item = await readSingleRichClipboardWrite(clipboard);
    const html = await readClipboardItemText(item, "text/html");
    expect(parseChatClipboardPayload(html).userMessage).toStrictEqual({
      version: 1,
      parts: [
        { type: "text", text: prompt },
        { type: "model", selectedModel: "claude-sonnet-4-6" },
      ],
    });
    expect(sentUserMessage).toStrictEqual({
      version: 1,
      parts: [
        { type: "text", text: prompt },
        { type: "model", selectedModel: "claude-sonnet-4-6" },
      ],
    });
  });

  it("includes the selected model in optimistic and sent user messages", async () => {
    const user = userEvent.setup({ delay: null });
    const clipboard = context.mocks.browser.clipboardWrite();
    const sendGate = context.mocks.deferred<void>();
    const threadId = "b0000000-0000-4000-a000-000000000993";
    const prompt = "Keep the model visible while sending";
    const selectedModel = "claude-sonnet-4-6";
    let sentUserMessage: UserMessageDocument | undefined;
    mockChatLifecycle(context, {
      threadId,
      selectedModel,
      sendGate: sendGate.promise,
      onSendRequest: ({ userMessage }) => {
        sentUserMessage = userMessage;
      },
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, prompt);

    await waitFor(() => {
      expect(screen.getByText(prompt)).toBeInTheDocument();
      expect(screen.getByLabelText("Copy message")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Copy message"));

    const item = await readSingleRichClipboardWrite(clipboard);
    const html = await readClipboardItemText(item, "text/html");
    expect(parseChatClipboardPayload(html).userMessage).toStrictEqual({
      version: 1,
      parts: [
        { type: "text", text: prompt },
        { type: "model", selectedModel },
      ],
    });
    expect(sentUserMessage).toStrictEqual({
      version: 1,
      parts: [
        { type: "text", text: prompt },
        { type: "model", selectedModel },
      ],
    });
  });

  it("renders the optimistic new chat message without skeleton when the initial event rows are blocked", async () => {
    const user = userEvent.setup({ delay: null });
    const prompt = "Show this while the initial list is blocked";
    const initialEventRows = context.mocks.deferred<void>();
    mockChatLifecycle(context);
    context.mocks.api(
      chatThreadEventsContract.rows,
      async ({ query, respond }) => {
        await initialEventRows.promise;
        return respond(200, chatEventRowsResponse([], query));
      },
    );

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, prompt);

    await waitFor(() => {
      expect(screen.getByText(prompt)).toBeInTheDocument();
      expect(document.querySelector("[data-chat-skeleton]")).toBeNull();
    });
  });

  it("reuses the thread container without carrying resolved history across threads", async () => {
    const user = userEvent.setup({ delay: null });
    const destinationInitialGate = context.mocks.deferred<void>();
    const sourceEvents = threadIsolationSourceEvents();
    const destinationEvents = threadIsolationDestinationEvents();
    const lifecycle = mockChatLifecycle(context, {
      threadId: THREAD_ISOLATION_SOURCE_ID,
      threadTitle: "Long thread",
      chatEvents: sourceEvents,
    });
    lifecycle.setThreadList(threadIsolationList());
    mockThreadEventRows({
      destinationThreadId: THREAD_ISOLATION_DESTINATION_ID,
      sourceEvents,
      destinationEvents,
      destinationInitialGate: destinationInitialGate.promise,
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ISOLATION_SOURCE_ID}`,
    });

    await expect(
      screen.findByText("Existing context"),
    ).resolves.toBeInTheDocument();
    const threadContainer = document.querySelector(
      `[data-chat-thread-container-id="${THREAD_ISOLATION_SOURCE_ID}"]`,
    );
    if (!(threadContainer instanceof HTMLElement)) {
      throw new Error("Chat thread container not found");
    }

    await user.click(linkByText("Other thread"));
    await waitFor(() => {
      expect(document.title).toBe("Other thread | VM0");
      expect(
        document.querySelector(
          `[data-chat-thread-container-id="${THREAD_ISOLATION_DESTINATION_ID}"]`,
        ),
      ).toBe(threadContainer);
      expect(screen.queryByText("Existing context")).not.toBeInTheDocument();
      expect(
        screen.queryByText("Send a message to start the conversation"),
      ).not.toBeInTheDocument();
      expect(document.querySelector("[data-chat-skeleton]")).not.toBeNull();
    });

    destinationInitialGate.resolve(undefined);
    await waitFor(() => {
      expect(screen.getByText("Other thread context")).toBeInTheDocument();
      expect(screen.queryByText("Existing context")).not.toBeInTheDocument();
    });
  });

  it("keeps active submission state scoped to its thread", async () => {
    const user = userEvent.setup({ delay: null });
    const sendGate = context.mocks.deferred<void>();
    const sourceEvents = threadIsolationSourceEvents();
    const destinationEvents = threadIsolationDestinationEvents();
    const lifecycle = mockChatLifecycle(context, {
      threadId: THREAD_ISOLATION_SOURCE_ID,
      threadTitle: "Long thread",
      sendGate: sendGate.promise,
      chatEvents: sourceEvents,
    });
    lifecycle.setThreadList(threadIsolationList());
    mockThreadEventRows({
      destinationThreadId: THREAD_ISOLATION_DESTINATION_ID,
      sourceEvents,
      destinationEvents,
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ISOLATION_SOURCE_ID}`,
    });

    await expect(
      screen.findByText("Existing context"),
    ).resolves.toBeInTheDocument();
    const textarea = screen.getByPlaceholderText(
      PLACEHOLDER,
    ) as HTMLTextAreaElement;
    await sendMessageInUI(user, textarea, "Pending follow-up");
    await waitFor(() => {
      expect(screen.getByText("Pending follow-up")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
    const threadContainer = document.querySelector(
      `[data-chat-thread-container-id="${THREAD_ISOLATION_SOURCE_ID}"]`,
    );
    if (!(threadContainer instanceof HTMLElement)) {
      throw new Error("Chat thread container not found");
    }
    expectTextBefore(
      document.body,
      "Existing assistant answer",
      "Pending follow-up",
    );

    await user.click(linkByText("Other thread"));
    await waitFor(() => {
      expect(document.title).toBe("Other thread | VM0");
      expect(screen.getByText("Other thread context")).toBeInTheDocument();
      expect(screen.queryByText("Pending follow-up")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(
        document.querySelector(
          `[data-chat-thread-container-id="${THREAD_ISOLATION_DESTINATION_ID}"]`,
        ),
      ).toBe(threadContainer);
    });
    const otherTextarea = screen.getByPlaceholderText(
      PLACEHOLDER,
    ) as HTMLTextAreaElement;
    await fillComposer(otherTextarea, "Fresh draft for other thread");
    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeEnabled();
    });

    await user.click(linkByText("Long thread"));
    await waitFor(() => {
      expect(document.title).toBe("Long thread | VM0");
      expect(screen.getByText("Pending follow-up")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(
        screen.queryByText("Other thread context"),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Existing context")).toBeInTheDocument();
      expect(
        document.querySelector(
          `[data-chat-thread-container-id="${THREAD_ISOLATION_SOURCE_ID}"]`,
        ),
      ).toBe(threadContainer);
    });
    expectTextBefore(
      document.body,
      "Existing assistant answer",
      "Pending follow-up",
    );
  });

  it("renders completed markdown and returns the composer to send mode", async () => {
    const user = userEvent.setup({ delay: null });
    const lifecycle = mockChatLifecycle(context);

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Summarize the launch plan");

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    lifecycle.completeRun("Here is the **result**");

    await waitFor(() => {
      expect(screen.getByText("result")).toBeInTheDocument();
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(document.querySelector("[data-chat-skeleton]")).toBeNull();
    });
  });

  it("renders user html-like text literally", async () => {
    const threadId = "e6000000-0000-4000-a000-000000000004";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          role: "user",
          content: "<span> 123 </span>",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const userBubble = await waitFor(() => {
      const bubble = document.querySelector(".zero-chat-bubble-user");
      expect(bubble).toBeInstanceOf(HTMLElement);
      expect(
        within(bubble as HTMLElement).getByText("<span> 123 </span>"),
      ).toBeInTheDocument();
      return bubble as HTMLElement;
    });

    expect(userBubble.querySelector("span span")).toBeNull();
  });

  it("ignores usage-only pages for rendering and thinking state", async () => {
    mockChatLifecycle(context, {
      threadId: "e6000000-0000-4000-a000-000000000005",
      chatEvents: [
        {
          id: "msg-usage-only",
          role: "assistant",
          content: null,
          runId: "run-usage-only",
          usage: {
            version: 1,
            totalCredits: 0,
            settledAt: "2026-06-09T10:00:02Z",
            breakdown: [
              {
                kind: "model",
                credits: 0,
                providers: [{ provider: "vm0", credits: 0 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/e6000000-0000-4000-a000-000000000005",
    });

    await waitFor(() => {
      expect(document.querySelector("[data-role='assistant']")).toBeNull();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });
  });

  it("shows thinking for an assistant run even without active run ids", async () => {
    mockChatLifecycle(context, {
      threadId: "e6000000-0000-4000-a000-000000000006",
      activeRunIds: [],
      chatEvents: [
        {
          id: "msg-message-list-assistant",
          role: "assistant",
          content: "I am working on this.",
          runId: "run-message-list-thinking",
          runEventId: "event-message-list-assistant-text",
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/e6000000-0000-4000-a000-000000000006",
    });

    await waitFor(() => {
      expect(screen.getByText("I am working on this.")).toBeInTheDocument();
      expect(
        document.querySelector("[data-thinking-indicator]"),
      ).not.toBeNull();
    });
  });

  it("shows thinking from loaded messages before thread metadata resolves", async () => {
    const threadGate = context.mocks.deferred<void>();
    mockChatLifecycle(context, {
      threadId: "e6000000-0000-4000-a000-000000000007",
      activeRunIds: ["run-message-list-thinking-pending-metadata"],
      threadGate: threadGate.promise,
      chatEvents: [
        {
          id: "msg-message-list-assistant-pending-metadata",
          role: "assistant",
          content: "I am still working on this.",
          runId: "run-message-list-thinking-pending-metadata",
          runEventId: "event-message-list-assistant-text-pending-metadata",
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/e6000000-0000-4000-a000-000000000007",
    });

    await screen.findByText("I am still working on this.");
    await waitFor(() => {
      expect(
        document.querySelector("[data-thinking-indicator]"),
      ).not.toBeNull();
    });

    threadGate.resolve();
  });

  it("clears thinking when the same run completes even with stale active run ids", async () => {
    mockChatLifecycle(context, {
      threadId: "e6000000-0000-4000-a000-000000000008",
      activeRunIds: ["run-message-list-completed"],
      chatEvents: [
        {
          id: "msg-message-list-completed-assistant",
          role: "assistant",
          content: "The answer is ready.",
          runId: "run-message-list-completed",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-message-list-completed-marker",
          role: "assistant",
          content: null,
          runId: "run-message-list-completed",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:01Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/e6000000-0000-4000-a000-000000000008",
    });

    await waitFor(() => {
      expect(screen.getByText("The answer is ready.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });
  });

  it("clears thinking for a completed latest run with an older terminated run", async () => {
    mockChatLifecycle(context, {
      threadId: "e6000000-0000-4000-a000-000000000009",
      activeRunIds: [],
      chatEvents: [
        {
          id: "msg-stale-run-user",
          role: "user",
          content: "Start the stale run",
          runId: "run-stale-without-marker",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-stale-run-assistant",
          role: "assistant",
          content: "This old run is already done.",
          runId: "run-stale-without-marker",
          runEventId: "event-stale-run-assistant-text",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-stale-run-completed-marker",
          role: "assistant",
          content: null,
          runId: "run-stale-without-marker",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:02Z",
        },
        {
          id: "msg-latest-run-user",
          role: "user",
          content: "Run the current task",
          runId: "run-latest-completed",
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-latest-run-assistant",
          role: "assistant",
          content: "The current task is complete.",
          runId: "run-latest-completed",
          runEventId: "event-latest-run-assistant-text",
          createdAt: "2026-06-09T10:01:01Z",
        },
        {
          id: "msg-latest-run-completed-marker",
          role: "assistant",
          content: null,
          runId: "run-latest-completed",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:01:02Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/e6000000-0000-4000-a000-000000000009",
    });

    await waitFor(() => {
      expect(
        screen.getByText("The current task is complete."),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });
  });

  it("ignores active run ids when loaded messages end at a completed run", async () => {
    mockChatLifecycle(context, {
      threadId: "e6000000-0000-4000-a000-000000000010",
      activeRunIds: ["run-r2"],
      chatEvents: [
        {
          id: "msg-stale-usage-r1",
          role: "assistant",
          content: null,
          runId: "run-r1",
          usage: {
            version: 1,
            totalCredits: 5,
            settledAt: "2026-06-09T10:00:00Z",
            breakdown: [
              {
                kind: "model/kimi-k2.5/tokens.input",
                credits: 5,
                providers: [{ provider: "moonshot", credits: 5 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-stale-user-r2",
          role: "user",
          content: "Continue the plan",
          runId: "run-r2",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-stale-start-r2",
          role: "assistant",
          content: null,
          runId: "run-r2",
          createdAt: "2026-06-09T10:00:02Z",
        },
        {
          id: "msg-stale-assistant-r2",
          role: "assistant",
          content: "The next step is ready.",
          runId: "run-r2",
          runEventId: "event-r2-assistant-text",
          createdAt: "2026-06-09T10:00:03Z",
        },
        {
          id: "msg-stale-completed-r3",
          role: "assistant",
          content: null,
          runId: "run-r3",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:04Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/e6000000-0000-4000-a000-000000000010",
    });

    await waitFor(() => {
      expect(screen.getByText("Continue the plan")).toBeInTheDocument();
      expect(screen.getByText("The next step is ready.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });
  });

  it("keeps thinking when the message stream shows later run activity", async () => {
    mockChatLifecycle(context, {
      threadId: "e6000000-0000-4000-a000-000000000011",
      activeRunIds: ["run-r2"],
      chatEvents: [
        {
          id: "msg-stale-active-later-usage-r1",
          role: "assistant",
          content: null,
          runId: "run-r1",
          usage: {
            version: 1,
            totalCredits: 5,
            settledAt: "2026-06-09T10:00:00Z",
            breakdown: [
              {
                kind: "model/kimi-k2.5/tokens.input",
                credits: 5,
                providers: [{ provider: "moonshot", credits: 5 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-stale-active-later-user-r2",
          role: "user",
          content: "Continue the plan",
          runId: "run-r2",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-stale-active-later-start-r2",
          role: "assistant",
          content: null,
          runId: "run-r2",
          createdAt: "2026-06-09T10:00:02Z",
        },
        {
          id: "msg-stale-active-later-assistant-r2",
          role: "assistant",
          content: "The next step is ready.",
          runId: "run-r2",
          runEventId: "event-r2-assistant-text-active-later",
          createdAt: "2026-06-09T10:00:03Z",
        },
        {
          id: "msg-stale-active-later-completed-r3",
          role: "assistant",
          content: null,
          runId: "run-r3",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:04Z",
        },
        {
          id: "msg-stale-active-later-thinking-r2",
          role: "assistant",
          content: null,
          thinking: "Continuing the plan",
          runId: "run-r2",
          createdAt: "2026-06-09T10:00:05Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/e6000000-0000-4000-a000-000000000011",
    });

    await waitFor(() => {
      expect(screen.getByText("Continue the plan")).toBeInTheDocument();
      expect(screen.getByText("The next step is ready.")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(
        document.querySelector("[data-thinking-indicator]"),
      ).not.toBeNull();
    });
  });

  it("clears thinking when only the latest completed marker is loaded after an older unterminated run", async () => {
    mockChatLifecycle(context, {
      threadId: COMPLETED_MARKER_ONLY_THREAD_ID,
      activeRunIds: [],
      chatEvents: [
        {
          id: "msg-marker-only-stale-user",
          role: "user",
          content: "Start an older run",
          runId: "run-marker-only-stale",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-marker-only-stale-assistant",
          role: "assistant",
          content: "This older run has already finished.",
          runId: "run-marker-only-stale",
          runEventId: "event-marker-only-stale-assistant-text",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-marker-only-stale-completed",
          role: "assistant",
          content: null,
          runId: "run-marker-only-stale",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:02Z",
        },
        {
          id: "msg-marker-only-completed",
          role: "assistant",
          content: null,
          runId: "run-marker-only-completed",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:01:02Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${COMPLETED_MARKER_ONLY_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("This older run has already finished."),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });
  });

  it("keeps completion when the loaded window does not include either run start", async () => {
    const threadId = "e6000000-0000-4000-a000-000000000012";
    mockChatLifecycle(context, {
      threadId,
      activeRunIds: ["run-window-older-active"],
      chatEvents: [
        {
          id: "msg-window-completed-activity",
          role: "assistant",
          content: "The visible completed run activity.",
          runId: "run-window-completed",
          runEventId: "event-window-completed-activity",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-window-older-active-activity",
          role: "assistant",
          content: "The visible older run activity.",
          runId: "run-window-older-active",
          runEventId: "event-window-older-active-activity",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-window-completed-marker",
          role: "assistant",
          content: null,
          runId: "run-window-completed",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("The visible completed run activity."),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });
  });

  it("does not use active run ids to revive an older run after a newer run completes", async () => {
    mockChatLifecycle(context, {
      threadId: "e6000000-0000-4000-a000-000000000013",
      activeRunIds: ["run-concurrent-active"],
      chatEvents: [
        {
          id: "msg-concurrent-active-user",
          role: "user",
          content: "Keep monitoring deployment",
          runId: "run-concurrent-active",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-concurrent-active-assistant",
          role: "assistant",
          content: "Monitoring is still running.",
          runId: "run-concurrent-active",
          runEventId: "event-concurrent-active-assistant-text",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-concurrent-completed-user",
          role: "user",
          content: "Summarize current status",
          runId: "run-concurrent-completed",
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-concurrent-completed-assistant",
          role: "assistant",
          content: "The current status summary is ready.",
          runId: "run-concurrent-completed",
          runEventId: "event-concurrent-completed-assistant-text",
          createdAt: "2026-06-09T10:01:01Z",
        },
        {
          id: "msg-concurrent-completed-marker",
          role: "assistant",
          content: null,
          runId: "run-concurrent-completed",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:01:02Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/e6000000-0000-4000-a000-000000000013",
    });

    await waitFor(() => {
      expect(
        screen.getByText("The current status summary is ready."),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });
  });

  it("keeps thinking for an active run when the message stream shows later activity", async () => {
    mockChatLifecycle(context, {
      threadId: "e6000000-0000-4000-a000-000000000014",
      activeRunIds: ["run-concurrent-active"],
      chatEvents: [
        {
          id: "msg-concurrent-active-later-user",
          role: "user",
          content: "Keep monitoring deployment",
          runId: "run-concurrent-active",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-concurrent-active-later-assistant",
          role: "assistant",
          content: "Monitoring is still running.",
          runId: "run-concurrent-active",
          runEventId: "event-concurrent-active-later-assistant-text",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-concurrent-active-later-completed-user",
          role: "user",
          content: "Summarize current status",
          runId: "run-concurrent-completed",
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-concurrent-active-later-completed-assistant",
          role: "assistant",
          content: "The current status summary is ready.",
          runId: "run-concurrent-completed",
          runEventId: "event-concurrent-active-later-completed-assistant-text",
          createdAt: "2026-06-09T10:01:01Z",
        },
        {
          id: "msg-concurrent-active-later-completed-marker",
          role: "assistant",
          content: null,
          runId: "run-concurrent-completed",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:01:02Z",
        },
        {
          id: "msg-concurrent-active-later-thinking",
          role: "assistant",
          content: null,
          thinking: "Still monitoring deployment",
          runId: "run-concurrent-active",
          createdAt: "2026-06-09T10:01:03Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/e6000000-0000-4000-a000-000000000014",
    });

    await waitFor(() => {
      expect(
        screen.getByText("The current status summary is ready."),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(
        document.querySelector("[data-thinking-indicator]"),
      ).not.toBeNull();
    });
  });

  it("does not use active run ids when active messages are outside the loaded window", async () => {
    mockChatLifecycle(context, {
      threadId: "e6000000-0000-4000-a000-000000000015",
      activeRunIds: ["run-active-outside-window"],
      chatEvents: [
        {
          id: "msg-window-completed-marker",
          role: "assistant",
          content: null,
          runId: "run-window-completed",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:01:02Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/e6000000-0000-4000-a000-000000000015",
    });

    await waitFor(() => {
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });
  });

  it("keeps interleaved run messages grouped by run turn", async () => {
    mockChatLifecycle(context, {
      threadId: "e6000000-0000-4000-a000-000000000016",
      chatEvents: [
        {
          id: "msg-run-a-user",
          role: "user",
          content: "Start run A",
          runId: "run-a",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-run-a-first-assistant",
          role: "assistant",
          content: "A first update",
          runId: "run-a",
          createdAt: "2026-06-09T10:00:02Z",
        },
        {
          id: "msg-run-b-user",
          role: "user",
          content: "Start run B",
          runId: "run-b",
          createdAt: "2026-06-09T10:00:03Z",
        },
        {
          id: "msg-run-a-final-assistant",
          role: "assistant",
          content: "A final update",
          runId: "run-a",
          createdAt: "2026-06-09T10:00:04Z",
        },
        {
          id: "msg-run-a-completed-marker",
          role: "assistant",
          content: null,
          runId: "run-a",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:05Z",
        },
        {
          id: "msg-run-b-assistant",
          role: "assistant",
          content: "B answer",
          runId: "run-b",
          createdAt: "2026-06-09T10:00:06Z",
        },
        {
          id: "msg-run-b-completed-marker",
          role: "assistant",
          content: null,
          runId: "run-b",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:07Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/e6000000-0000-4000-a000-000000000016",
    });

    await waitFor(() => {
      expect(screen.getByText("A final update")).toBeInTheDocument();
      expect(screen.getByText("Start run B")).toBeInTheDocument();
      expect(screen.getByText("B answer")).toBeInTheDocument();
    });

    expectTextBefore(document.body, "A final update", "Start run B");
    expectTextBefore(document.body, "Start run B", "B answer");
    expect(document.querySelectorAll('[data-role="assistant"]')).toHaveLength(
      2,
    );
  });

  it("shows thinking when the latest message is a user message", async () => {
    mockChatLifecycle(context, {
      threadId: "e6000000-0000-4000-a000-000000000017",
      activeRunIds: [],
      chatEvents: [
        {
          id: "msg-message-list-latest-user",
          role: "user",
          content: "Start the next run",
          runId: "run-message-list-latest-user",
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/e6000000-0000-4000-a000-000000000017",
    });

    await waitFor(() => {
      expect(screen.getByText("Start the next run")).toBeInTheDocument();
      expect(
        document.querySelector("[data-thinking-indicator]"),
      ).not.toBeNull();
    });
  });

  it("clears thinking when a run is cancelled", async () => {
    mockChatLifecycle(context, {
      threadId: "e6000000-0000-4000-a000-000000000018",
      activeRunIds: ["run-message-list-cancelled"],
      chatEvents: [
        {
          id: "msg-message-list-cancelled-assistant",
          role: "assistant",
          content: "I started this run.",
          runId: "run-message-list-cancelled",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-message-list-cancelled-marker",
          role: "assistant",
          content: "Run cancelled",
          runId: "run-message-list-cancelled",
          error: "Run cancelled",
          runLifecycleEvent: "cancelled",
          createdAt: "2026-06-09T10:00:01Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/e6000000-0000-4000-a000-000000000018",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Paused mid-thought — pick it back up whenever."),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });
  });
});
