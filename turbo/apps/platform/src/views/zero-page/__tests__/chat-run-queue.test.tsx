import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type {
  ChatRunOptionsRequest,
  PersistedAttachment,
} from "@vm0/api-contracts/contracts/chat-threads";
import type {
  ModelProviderResponse,
  OrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
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

interface ModelSelectionRequest {
  readonly modelProviderId: string;
  readonly selectedModel: string;
}

interface QueuedMessageCapture {
  content?: string;
  hasTextContent?: boolean;
  attachments?: PersistedAttachment[];
  clientMessageId: string;
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
    readonly onQueuedMessageAppend?: (body: QueuedMessageCapture) => void;
  },
): void {
  mockChatLifecycle(context, {
    threadId,
    ...(options?.selectedModel ? { selectedModel: options.selectedModel } : {}),
    ...(options?.codexServiceTier
      ? { codexServiceTier: options.codexServiceTier }
      : {}),
    chatMessages: [
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
    ...(options?.onQueuedMessageAppend
      ? { onQueuedMessageAppend: options.onQueuedMessageAppend }
      : {}),
  });
}

describe("chat run queue", () => {
  it("labels a structured queued message from its ordered parts", async () => {
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatMessages: [
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
          content: "stale queued label",
          runId: undefined,
          structuredPrompt: {
            version: 1,
            parts: [
              {
                type: "file",
                fileId: "roadmap-file",
                filenameSnapshot: "roadmap.pdf",
                contentType: "application/pdf",
              },
              { type: "text", text: "Review the roadmap" },
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
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: true },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "[File: roadmap.pdf] Review the roadmap",
      );
    });
    expect(screen.queryByText("stale queued label")).not.toBeInTheDocument();
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
      onQueuedMessageAppend: (body) => {
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
      chatMessages: [
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
      onQueuedMessageAppend: (body) => {
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
      onQueuedMessageAppend: (body) => {
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
      onQueuedMessageAppend: (body) => {
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
      onQueuedMessageAppend: (body) => {
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
      chatMessages: [
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
      onQueuedMessageAppend: (body) => {
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
        "(see attached files)",
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
