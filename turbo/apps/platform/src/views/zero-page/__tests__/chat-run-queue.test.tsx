import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  chatThreadByIdContract,
  type ChatRunOptionsRequest,
  type PersistedAttachment,
} from "@vm0/api-contracts/contracts/chat-threads";
import type {
  ModelProviderResponse,
  OrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { i18n } from "../../../i18n/index.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { triggerAblyEvent, triggerAblyReconnect } from "../../../mocks/ably.ts";
import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import {
  activeRunComposer,
  expectQueuedMessages,
  mockChatLifecycle,
  PLACEHOLDER,
  sendQueuedMessage,
  sendMessageInUI,
} from "./chat-test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000901";
const CHAT_PATH = `/chats/${THREAD_ID}`;
const AGENT_CHAT_PATH = `/agents/${AGENT_ID}/chat`;
const CANCELLATION_RECOVERY_COPY =
  "Preparing the cancelled session before queued work continues.";

afterEach(async () => {
  await i18n.changeLanguage("en-US");
  document.documentElement.lang = "en-US";
});

interface ModelSelectionRequest {
  readonly modelProviderId: string;
  readonly selectedModel: string;
}

interface QueuedMessageCapture {
  content?: string;
  hasTextContent?: boolean;
  attachments?: PersistedAttachment[];
  clientEventId: string;
  modelSelection?: ModelSelectionRequest | null;
  runOptions?: ChatRunOptionsRequest;
}

function buildModelPolicy(
  overrides: Partial<OrgModelPolicy> & Pick<OrgModelPolicy, "model">,
): OrgModelPolicy {
  return {
    id: crypto.randomUUID(),
    modelLabel: overrides.model,
    isDefault: true,
    defaultProviderType: "vm0",
    credentialScope: "org",
    modelProviderId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

function buildProvider(
  overrides: Partial<ModelProviderResponse> &
    Pick<ModelProviderResponse, "id" | "type">,
): ModelProviderResponse {
  return {
    framework: "codex",
    secretName: null,
    authMethod: "auth_json",
    secretNames: ["CODEX_AUTH_JSON"],
    isDefault: false,
    selectedModel: null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

async function startActiveRun(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  const textarea = await waitFor(() => {
    return screen.getByRole("textbox", { name: "Message" });
  });
  await sendMessageInUI(user, textarea, "Start the active run");

  await waitFor(() => {
    expect(screen.getByLabelText("Stop")).toBeInTheDocument();
  });

  return activeRunComposer();
}

function mockActiveRunThread(
  threadId: string,
  options?: {
    readonly selectedModel?: string;
    readonly codexServiceTier?: "fast";
    readonly onQueuedEventAppend?: (body: QueuedMessageCapture) => void;
  },
): void {
  mockChatLifecycle(context, {
    threadId,
    ...(options?.selectedModel ? { selectedModel: options.selectedModel } : {}),
    ...(options?.codexServiceTier
      ? { codexServiceTier: options.codexServiceTier }
      : {}),
    chatEvents: [
      {
        id: `${threadId}-active-user`,
        role: "user",
        content: "Start the active run",
        runId: "run-active",
        createdAt: "2026-06-09T10:00:00Z",
      },
      {
        id: `${threadId}-active-assistant`,
        role: "assistant",
        content: null,
        runId: "run-active",
        createdAt: "2026-06-09T10:00:01Z",
      },
    ],
    activeRunIds: ["run-active"],
    ...(options?.onQueuedEventAppend
      ? { onQueuedEventAppend: options.onQueuedEventAppend }
      : {}),
  });
}

function mockCancellationRecoveryQueue(options?: {
  readonly includeAutomation?: boolean;
  readonly onRecallEventAppend?: (body: {
    revokesEventId: string;
    clientEventId: string;
  }) => void;
}): void {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: `${THREAD_ID}-cancelled-user`,
        role: "user",
        content: "Start work that will be cancelled",
        runId: "run-cancelled",
        createdAt: "2026-07-30T10:00:00Z",
      },
      {
        id: `${THREAD_ID}-cancelled-assistant`,
        role: "assistant",
        content: "Run cancelled",
        error: "Run cancelled",
        runId: "run-cancelled",
        runLifecycleEvent: "cancelled",
        createdAt: "2026-07-30T10:00:01Z",
      },
      {
        id: `${THREAD_ID}-queued-user`,
        role: "user",
        content: "Continue after recovery",
        runId: undefined,
        createdAt: "2026-07-30T10:00:02Z",
      },
      ...(options?.includeAutomation
        ? [
            {
              id: `${THREAD_ID}-queued-automation`,
              eventType: "input.automation" as const,
              content: null,
              automationId: "e0000001-0000-4000-a000-000000000001",
              triggerSource: "workflow-event" as const,
              triggerBrief: "Process the queued automation",
              runId: undefined,
              createdAt: "2026-07-30T10:00:03Z",
            },
          ]
        : []),
    ],
    onRecallEventAppend: options?.onRecallEventAppend,
  });
}

describe("chat run queue", () => {
  it("falls back to generic queue guidance for a previous API response", async () => {
    mockCancellationRecoveryQueue();
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, { lastReadAt: null });
    });

    detachedSetupPage({ context, path: CHAT_PATH });

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "Continue after recovery",
      );
    });
    expect(
      screen.queryByText(CANCELLATION_RECOVERY_COPY),
    ).not.toBeInTheDocument();

    click(screen.getByLabelText("About this queued message"));
    await expect(
      screen.findByText(
        "Waits in line and sends once the current run finishes.",
      ),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByText(CANCELLATION_RECOVERY_COPY),
    ).not.toBeInTheDocument();
  });

  it("treats missing thread detail as no reported recovery", async () => {
    mockCancellationRecoveryQueue();
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(404, {
        error: { message: "Thread not found", code: "NOT_FOUND" },
      });
    });

    detachedSetupPage({ context, path: CHAT_PATH });

    await expect(
      screen.findByLabelText("Queued message"),
    ).resolves.toHaveTextContent("Continue after recovery");
    expect(
      screen.queryByText(CANCELLATION_RECOVERY_COPY),
    ).not.toBeInTheDocument();
  });

  it("explains recovery without disabling queued work or the composer", async () => {
    const recalledEventIds: string[] = [];
    mockCancellationRecoveryQueue({
      includeAutomation: true,
      onRecallEventAppend: ({ revokesEventId }) => {
        recalledEventIds.push(revokesEventId);
      },
    });
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
        cancellationRecoveryPending: true,
      });
    });

    detachedSetupPage({ context, path: CHAT_PATH });

    const recoveryStatus = await screen.findByText(CANCELLATION_RECOVERY_COPY);
    expect(recoveryStatus).toHaveAttribute("role", "status");
    expect(recoveryStatus).toHaveAttribute("aria-live", "polite");
    expect(
      screen.getByText("Paused mid-thought — pick it back up whenever."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Queued message")).toHaveTextContent(
      "Continue after recovery",
    );
    expect(screen.getByLabelText("Pending automation event")).toHaveTextContent(
      "Process the queued automation",
    );
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();

    click(screen.getByLabelText("About this queued message"));
    await waitFor(() => {
      expect(screen.getAllByText(CANCELLATION_RECOVERY_COPY)).toHaveLength(2);
    });
    fireEvent.keyDown(document, { key: "Escape" });

    click(screen.getByLabelText("About this automation event"));
    await waitFor(() => {
      expect(screen.getAllByText(CANCELLATION_RECOVERY_COPY)).toHaveLength(2);
    });
    fireEvent.keyDown(document, { key: "Escape" });

    click(screen.getByLabelText("Remove queued message"));
    await waitFor(() => {
      expect(recalledEventIds).toContain(`${THREAD_ID}-queued-user`);
    });
    click(screen.getByLabelText("Skip automation event"));
    await waitFor(() => {
      expect(recalledEventIds).toContain(`${THREAD_ID}-queued-automation`);
    });
  });

  it("catches recovery changes after the initial detail read", async () => {
    let detailReads = 0;
    mockCancellationRecoveryQueue();
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      detailReads += 1;
      return respond(200, {
        lastReadAt: null,
        cancellationRecoveryPending: detailReads > 1,
      });
    });

    detachedSetupPage({ context, path: CHAT_PATH });

    await expect(
      screen.findByText(CANCELLATION_RECOVERY_COPY),
    ).resolves.toBeInTheDocument();
    expect(detailReads).toBeGreaterThanOrEqual(2);
  });

  it("reloads recovery state on detail events and reconnect", async () => {
    let cancellationRecoveryPending = false;
    let detailReads = 0;
    mockCancellationRecoveryQueue();
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      detailReads += 1;
      return respond(200, {
        lastReadAt: null,
        cancellationRecoveryPending,
      });
    });

    detachedSetupPage({ context, path: CHAT_PATH });

    await waitFor(() => {
      expect(detailReads).toBeGreaterThan(0);
      expect(screen.getByLabelText("Queued message")).toBeInTheDocument();
    });
    expect(
      screen.queryByText(CANCELLATION_RECOVERY_COPY),
    ).not.toBeInTheDocument();

    cancellationRecoveryPending = true;
    triggerAblyEvent(`chatThreadDetailChanged:${THREAD_ID}`);
    await expect(
      screen.findByText(CANCELLATION_RECOVERY_COPY),
    ).resolves.toBeInTheDocument();

    cancellationRecoveryPending = false;
    triggerAblyEvent(`chatThreadDetailChanged:${THREAD_ID}`);
    await waitFor(() => {
      expect(
        screen.queryByText(CANCELLATION_RECOVERY_COPY),
      ).not.toBeInTheDocument();
    });

    cancellationRecoveryPending = true;
    triggerAblyReconnect();
    await expect(
      screen.findByText(CANCELLATION_RECOVERY_COPY),
    ).resolves.toBeInTheDocument();
  });

  it("localizes cancellation recovery guidance", async () => {
    context.mocks.data.userPreferences({ locale: "pt-BR" });
    mockCancellationRecoveryQueue();
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
        cancellationRecoveryPending: true,
      });
    });

    detachedSetupPage({ context, path: CHAT_PATH });

    await expect(
      screen.findByText(
        "Preparando a sessão cancelada antes de continuar o trabalho na fila.",
      ),
    ).resolves.toBeInTheDocument();
  });

  it("labels a queued message from its userMessage projection", async () => {
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatEvents: [
        {
          id: `${THREAD_ID}-active-user`,
          role: "user",
          content: "Start the active run",
          runId: "run-active",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: `${THREAD_ID}-active-assistant`,
          role: "assistant",
          content: null,
          runId: "run-active",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: `${THREAD_ID}-queued-user`,
          role: "user",
          content: "legacy queued label",
          runId: undefined,
          userMessage: {
            version: 1,
            parts: [
              {
                type: "template",
                titleSnapshot: "Pitch deck",
                template: {
                  type: "illustration",
                  selection: { illustrationStyleId: "editorial" },
                },
              },
              {
                type: "file",
                fileId: "file-one",
                filenameSnapshot: "file-one.pdf",
                contentType: "application/pdf",
              },
              {
                type: "file",
                fileId: "file-two",
                filenameSnapshot: "file-two.txt",
                contentType: "text/plain",
              },
              { type: "text", text: "  Review " },
              {
                type: "chat_thread",
                threadId: THREAD_ID,
                titleSnapshot: "Project Alpha",
              },
              { type: "text", text: " then\ncontinue" },
            ],
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
      activeRunIds: ["run-active"],
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
    });

    const userMessageLabel =
      "[Template: Pitch deck] [File: file-one.pdf] [File: file-two.txt] " +
      "Review [Chat thread: Project Alpha] then continue";
    const legacyLabel = "legacy queued label";
    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        userMessageLabel,
      );
    });
    expect(screen.getByLabelText("Queued message")).not.toHaveTextContent(
      legacyLabel,
    );
  });

  it("shows a sent message and stop control while a new chat run is active", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Summarize the launch plan");

    await waitFor(() => {
      expect(screen.getByText("Summarize the launch plan")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });

  it("does not queue follow-ups while an optimistic new thread create is unsettled", async () => {
    const user = userEvent.setup({ delay: null });
    const sendGate = context.mocks.deferred<void>();
    const queuedBodies: QueuedMessageCapture[] = [];
    mockChatLifecycle(context, {
      sendGate: sendGate.promise,
      onQueuedEventAppend: (body) => {
        queuedBodies.push(body);
      },
    });

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "First new-thread message");

    await waitFor(() => {
      expect(screen.getByText("First new-thread message")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    await sendQueuedMessage(user, "Blocked follow-up");

    await waitFor(() => {
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
      expect(queuedBodies).toHaveLength(0);
    });

    sendGate.resolve();

    await waitFor(() => {
      expect(screen.getByText("First new-thread message")).toBeInTheDocument();
    });
  });

  it("replays recalled queued content during an active run", async () => {
    const user = userEvent.setup({ delay: null });
    mockActiveRunThread(THREAD_ID);

    detachedSetupPage({ context, path: CHAT_PATH });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    await sendQueuedMessage(user, "First queued follow-up");
    await sendQueuedMessage(user, "Second queued follow-up");
    await expectQueuedMessages([
      "First queued follow-up",
      "Second queued follow-up",
    ]);

    click(screen.getAllByLabelText("Remove queued message")[0]!);

    await waitFor(() => {
      expect(
        screen.getByRole("textbox", { name: "Message" }),
      ).toHaveTextContent("First queued follow-up");
    });

    await fill(
      screen.getByRole("textbox", { name: "Message" }),
      "Replayed follow-up",
    );
    await user.keyboard("{Enter}");

    await expectQueuedMessages([
      "Second queued follow-up",
      "Replayed follow-up",
    ]);
  });

  it("omits model selection when queueing a follow-up on an existing thread", async () => {
    const user = userEvent.setup({ delay: null });
    const queuedBodies: QueuedMessageCapture[] = [];
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        model: "claude-sonnet-4-6",
        modelLabel: "Claude Sonnet 4.6",
      }),
    ]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "claude-sonnet-4-6",
      chatEvents: [
        {
          id: `${THREAD_ID}-active-user`,
          role: "user",
          content: "Start the active run",
          runId: "run-active",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: `${THREAD_ID}-active-assistant`,
          role: "assistant",
          content: null,
          runId: "run-active",
          createdAt: "2026-06-09T10:00:01Z",
        },
      ],
      activeRunIds: ["run-active"],
      onQueuedEventAppend: (body) => {
        queuedBodies.push(body);
      },
    });

    detachedSetupPage({ context, path: CHAT_PATH });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    await sendQueuedMessage(user, "Queued follow-up");

    await waitFor(() => {
      expect(queuedBodies).toHaveLength(1);
    });
    expect(queuedBodies[0]?.modelSelection).toBeUndefined();
  });

  it("queues the committed composer text after IME composition ends", async () => {
    const queuedBodies: QueuedMessageCapture[] = [];
    mockActiveRunThread(THREAD_ID, {
      onQueuedEventAppend: (body) => {
        queuedBodies.push(body);
      },
    });

    detachedSetupPage({ context, path: CHAT_PATH });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
    const composer = await activeRunComposer();
    await fill(composer, "排");

    fireEvent.compositionStart(composer, { data: "排" });
    const paragraph = composer.querySelector("p");
    if (!paragraph) {
      throw new Error("Composer paragraph not found");
    }
    paragraph.textContent = "排队完整内容";

    fireEvent.click(screen.getByLabelText("Send"));
    expect(queuedBodies).toHaveLength(0);

    fireEvent.compositionEnd(composer, { data: "排队完整内容" });
    fireEvent.input(composer, {
      data: "排队完整内容",
      inputType: "insertCompositionText",
      isComposing: false,
    });

    await waitFor(() => {
      expect(queuedBodies).toHaveLength(1);
    });
    expect(queuedBodies[0]?.content).toBe("排队完整内容");
  });

  it("queues when the hydrated model needs server reconciliation", async () => {
    const user = userEvent.setup({ delay: null });
    const queuedBodies: QueuedMessageCapture[] = [];
    context.mocks.data.orgModelPolicies([]);
    mockActiveRunThread(THREAD_ID, {
      selectedModel: "gpt-5.5",
      onQueuedEventAppend: (body) => {
        queuedBodies.push(body);
      },
    });

    detachedSetupPage({ context, path: CHAT_PATH });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
    const composer = await activeRunComposer();
    await fill(composer, "Keep this queued draft");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(queuedBodies).toHaveLength(1);
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "Keep this queued draft",
      );
    });
    expect(queuedBodies[0]?.modelSelection).toBeUndefined();
    expect(
      screen.queryByText("The selected model is not available"),
    ).not.toBeInTheDocument();
    expect(composer.textContent).toBe("");
  });

  it("preserves Codex fast mode when queueing a follow-up", async () => {
    const user = userEvent.setup({ delay: null });
    const queuedBodies: QueuedMessageCapture[] = [];
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        model: "gpt-5.5",
        modelLabel: "GPT 5.5",
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([
      buildProvider({
        id: "00000000-0000-4000-a000-000000000931",
        type: "codex-oauth-token",
      }),
    ]);
    mockActiveRunThread(THREAD_ID, {
      selectedModel: "gpt-5.5",
      codexServiceTier: "fast",
      onQueuedEventAppend: (body) => {
        queuedBodies.push(body);
      },
    });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.CodexFastMode]: true },
      path: CHAT_PATH,
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
    await sendQueuedMessage(user, "Queued fast follow-up");

    await waitFor(() => {
      expect(queuedBodies).toHaveLength(1);
    });
    expect(queuedBodies[0]?.runOptions).toStrictEqual({
      codexServiceTier: "fast",
    });
  });

  it("queues an attachment-only follow-up during an active run", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000902";
    let queuedBody: QueuedMessageCapture | null = null;

    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-active-attachment-user",
          role: "user",
          content: "Start the active run",
          runId: "run-active",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-active-attachment-assistant",
          role: "assistant",
          content: null,
          runId: "run-active",
          createdAt: "2026-06-09T10:00:01Z",
        },
      ],
      activeRunIds: ["run-active"],
      onQueuedEventAppend: (body) => {
        queuedBody = body;
      },
    });
    context.mocks.upload.success({
      id: "upload-notes",
      filename: "notes.txt",
      contentType: "text/plain",
      size: 12,
      url: "https://cdn.vm7.io/artifacts/test/upload-notes/notes.txt",
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) {
      throw new Error("file input not found");
    }
    await user.upload(
      fileInput,
      new File(["release note"], "notes.txt", { type: "text/plain" }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Remove notes.txt")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Send"));

    await waitFor(() => {
      expect(screen.getByText("1 message waiting")).toBeInTheDocument();
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "[File: notes.txt]",
      );
      expect(queuedBody).toMatchObject({
        content: "(see attached files)",
        hasTextContent: false,
        attachments: [
          {
            id: "upload-notes",
            filename: "notes.txt",
            contentType: "text/plain",
            size: 12,
            url: "https://cdn.vm7.io/artifacts/test/upload-notes/notes.txt",
          },
        ],
      });
    });
  });

  it("recalls queued content and clears the thinking indicator when the active run is stopped", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({ context, path: CHAT_PATH });

    await startActiveRun(user);
    await sendQueuedMessage(user, "First queued");
    await sendQueuedMessage(user, "Second queued");
    await expectQueuedMessages(["First queued", "Second queued"]);

    click(screen.getByLabelText("Stop"));

    await waitFor(() => {
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(
        document.querySelector("[data-thinking-indicator]"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("Paused mid-thought — pick it back up whenever."),
      ).toBeInTheDocument();
    });
  });
});
