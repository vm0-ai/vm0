import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { chatThreadMessagesContract } from "@vm0/api-contracts/contracts/chat-threads";
import { eventDrivenChatThread } from "../../../signals/chat-page/chat-thread-event-sourcing.ts";
import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import {
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
  chatComposerTextarea,
} from "./chat-lifecycle-test-helpers.ts";

describe("chat lifecycle", () => {
  it("links Slack-origin user messages back to the original message", async () => {
    const threadId = "thread-slack-message-origin";
    const permalink =
      "https://vm0.slack.com/archives/C12345678/p1753257600000100";
    mockChatLifecycle(context, {
      threadId,
      chatMessages: [
        {
          id: "msg-slack-origin",
          role: "user",
          content: "Check the production rollout",
          runId: "run-slack-origin",
          triggerSource: "slack",
          slackMessagePermalink: permalink,
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
          triggerSource: "slack",
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
  });

  it("links Feishu-origin user messages back to the original chat", async () => {
    const threadId = "thread-feishu-message-origin";
    const chatOpenUrl =
      "https://applink.feishu.cn/client/chat/open?openChatId=oc_feishu_chat";
    mockChatLifecycle(context, {
      threadId,
      chatMessages: [
        {
          id: "msg-feishu-origin",
          role: "user",
          content: "Check the Feishu conversation",
          runId: "run-feishu-origin",
          triggerSource: "feishu",
          feishuChatOpenUrl: chatOpenUrl,
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
          triggerSource: "feishu",
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
  });

  it("keeps an existing thread composer in its footer while idle and working", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000990";
    mockChatLifecycle(context, {
      threadId,
      chatMessages: [
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
    expect(composerCard?.closest("[data-chat-composer]")).not.toBeNull();

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

  it("subscribes the browser for push notifications after a visible chat send", async () => {
    const user = userEvent.setup({ delay: null });
    const pushBrowser = mockPushBrowserSupport();
    let capturedSubscription: unknown;
    context.mocks.http.post(
      "*/api/zero/push-subscriptions",
      async ({ request }) => {
        capturedSubscription = await request.json();
        return new Response(null, { status: 204 });
      },
    );
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

  it("starts a new chat with a visual attachment", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.data.userModelPreference({
      selectedModel: "claude-sonnet-4-6",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    context.mocks.data.orgModelPolicies([
      {
        id: "00000000-0000-4000-a000-000000000719",
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
    mockChatLifecycle(context);
    context.mocks.upload.success({
      id: "upload-visual-brief",
      filename: "brief.png",
      contentType: "image/png",
      size: 128,
      url: "https://cdn.vm7.io/artifacts/test/upload-visual-brief/brief.png",
    });

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

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
      new File(["image-bytes"], "brief.png", { type: "image/png" }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Remove brief.png")).toBeInTheDocument();
    });

    await sendMessageInUI(user, textarea, "Summarize this visual brief");

    await waitFor(() => {
      expect(
        screen.getByText("Summarize this visual brief"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });

  it("projects the first-run model from the optimistic created event", async () => {
    const user = userEvent.setup({ delay: null });
    const prompt = "Start with my preferred model";
    const sendGate = context.mocks.deferred<void>();
    let clientThreadId: string | undefined;
    context.mocks.data.userModelPreference({
      selectedModel: "claude-sonnet-4-6",
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
  });

  it("renders the optimistic new chat message without skeleton when the initial message list is blocked", async () => {
    const user = userEvent.setup({ delay: null });
    const prompt = "Show this while the initial list is blocked";
    const initialMessageList = context.mocks.deferred<void>();
    mockChatLifecycle(context);
    context.mocks.api(chatThreadMessagesContract.list, async ({ respond }) => {
      await initialMessageList.promise;
      return respond(200, { messages: [], hasHistoryBefore: false });
    });

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

  it("keeps the thread container without carrying resolved history or submission state across threads", async () => {
    const user = userEvent.setup({ delay: null });
    const sendGate = context.mocks.deferred<void>();
    const otherThreadMessagesGate = context.mocks.deferred<void>();
    const threadId = "b0000000-0000-4000-a000-000000000901";
    const otherThreadId = "b0000000-0000-4000-a000-000000000902";
    const lifecycle = mockChatLifecycle(context, {
      threadId,
      threadTitle: "Long thread",
      sendGate: sendGate.promise,
      chatMessages: [
        {
          id: "msg-existing-user",
          role: "user",
          runId: "run-existing",
          content: "Existing context before follow-up",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "msg-existing-assistant",
          role: "assistant",
          runId: "run-existing",
          content: "Existing assistant answer",
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
    });
    lifecycle.setThreadList([
      {
        id: threadId,
        title: "Long thread",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:01Z",
      },
      {
        id: otherThreadId,
        title: "Other thread",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    context.mocks.api(
      chatThreadMessagesContract.list,
      async ({ params, query, respond }) => {
        if (query.sinceSeqId || query.beforeSeqId) {
          return respond(200, { messages: [] });
        }
        if (params.threadId === otherThreadId) {
          await otherThreadMessagesGate.promise;
          return respond(200, {
            messages: [
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
            ],
            hasHistoryBefore: false,
          });
        }
        return respond(200, {
          messages: [
            {
              id: "msg-existing-user",
              seqId: 1,
              role: "user",
              runId: "run-existing",
              content: "Existing context before follow-up",
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
          ],
          hasHistoryBefore: false,
        });
      },
    );

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await expect(
      screen.findByText("Existing context before follow-up"),
    ).resolves.toBeInTheDocument();
    const threadContainer = document.querySelector(
      `[data-chat-thread-container-id="${threadId}"]`,
    );
    if (!(threadContainer instanceof HTMLElement)) {
      throw new Error("Chat thread container not found");
    }

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Pending follow-up");

    await waitFor(() => {
      expect(screen.getByText("Pending follow-up")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
    expectTextBefore(
      document.body,
      "Existing assistant answer",
      "Pending follow-up",
    );

    await user.click(linkByText("Other thread"));
    await waitFor(() => {
      expect(document.title).toBe("Other thread | VM0");
      expect(
        document.querySelector(
          `[data-chat-thread-container-id="${otherThreadId}"]`,
        ),
      ).toBe(threadContainer);
      expect(
        screen.queryByText("Existing context before follow-up"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Pending follow-up")).not.toBeInTheDocument();
    });

    otherThreadMessagesGate.resolve(undefined);
    await waitFor(() => {
      expect(screen.getByText("Other thread context")).toBeInTheDocument();
    });
    const otherTextarea = screen.getByPlaceholderText(
      PLACEHOLDER,
    ) as HTMLTextAreaElement;
    await user.type(otherTextarea, "Fresh draft for other thread");
    expect(screen.getByLabelText("Send")).toBeEnabled();

    await user.click(linkByText("Long thread"));
    await waitFor(() => {
      expect(document.title).toBe("Long thread | VM0");
      expect(screen.getByText("Pending follow-up")).toBeInTheDocument();
      expect(
        screen.queryByText("Other thread context"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("Existing context before follow-up"),
      ).toBeInTheDocument();
      expect(
        document.querySelector(`[data-chat-thread-container-id="${threadId}"]`),
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
    const threadId = "thread-user-html-like-text";
    mockChatLifecycle(context, {
      threadId,
      chatMessages: [
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

    expect(userBubble.querySelector("span")).toBeNull();
  });

  it("ignores usage-only pages for rendering and thinking state", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-usage-only",
      chatMessages: [
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
      path: "/chats/thread-usage-only",
    });

    await waitFor(() => {
      expect(document.querySelector("[data-role='assistant']")).toBeNull();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });
  });

  it("shows thinking for an assistant run even without active run ids", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-message-list-thinking",
      activeRunIds: [],
      chatMessages: [
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
      path: "/chats/thread-message-list-thinking",
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
      threadId: "thread-message-list-thinking-pending-metadata",
      activeRunIds: ["run-message-list-thinking-pending-metadata"],
      threadGate: threadGate.promise,
      chatMessages: [
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
      path: "/chats/thread-message-list-thinking-pending-metadata",
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
      threadId: "thread-message-list-completed",
      activeRunIds: ["run-message-list-completed"],
      chatMessages: [
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
      path: "/chats/thread-message-list-completed",
    });

    await waitFor(() => {
      expect(screen.getByText("The answer is ready.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });
  });

  it("clears thinking for a completed latest run with an older terminated run", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-stale-run-before-completed-latest-run",
      activeRunIds: [],
      chatMessages: [
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
      path: "/chats/thread-stale-run-before-completed-latest-run",
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
      threadId: "thread-stale-lifecycle-thinking",
      activeRunIds: ["run-r2"],
      chatMessages: [
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
      path: "/chats/thread-stale-lifecycle-thinking",
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
      threadId: "thread-stale-lifecycle-thinking-active-later",
      activeRunIds: ["run-r2"],
      chatMessages: [
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
      path: "/chats/thread-stale-lifecycle-thinking-active-later",
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
      chatMessages: [
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
    const threadId = "thread-run-starts-outside-loaded-window";
    mockChatLifecycle(context, {
      threadId,
      activeRunIds: ["run-window-older-active"],
      chatMessages: [
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
      threadId: "thread-concurrent-run-completed-later",
      activeRunIds: ["run-concurrent-active"],
      chatMessages: [
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
      path: "/chats/thread-concurrent-run-completed-later",
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
      threadId: "thread-concurrent-run-active-later",
      activeRunIds: ["run-concurrent-active"],
      chatMessages: [
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
      path: "/chats/thread-concurrent-run-active-later",
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
      threadId: "thread-active-run-outside-loaded-window",
      activeRunIds: ["run-active-outside-window"],
      chatMessages: [
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
      path: "/chats/thread-active-run-outside-loaded-window",
    });

    await waitFor(() => {
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });
  });

  it("keeps interleaved run messages grouped by run turn", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-interleaved-run-turns",
      chatMessages: [
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
      path: "/chats/thread-interleaved-run-turns",
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
      threadId: "thread-message-list-latest-user",
      activeRunIds: [],
      chatMessages: [
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
      path: "/chats/thread-message-list-latest-user",
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
      threadId: "thread-message-list-cancelled",
      activeRunIds: ["run-message-list-cancelled"],
      chatMessages: [
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
      path: "/chats/thread-message-list-cancelled",
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
