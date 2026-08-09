import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  chatThreadByIdContract,
  type ChatRunOptionsRequest,
  type UserMessageDocument,
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
  "Finalizing the cancelled run before queued work continues.";
const NEXT_RUN_MODEL_COPY = "Next run will use Claude Opus 4.8";
const MODEL_CHANGED_COPY = "Model changed to Claude Sonnet 4.6";

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
  clientEventId: string;
  userMessage?: UserMessageDocument;
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

function modelAnnotatedMessage(
  text: string,
  selectedModel: string | undefined,
): UserMessageDocument {
  return {
    version: 1,
    parts: [
      { type: "text", text },
      ...(selectedModel === undefined
        ? []
        : [{ type: "model" as const, selectedModel }]),
    ],
  };
}

function expectTextBefore(firstText: string, secondText: string): void {
  const first = screen.getByText(firstText);
  const second = screen.getByText(secondText);
  expect(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
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

function mockActiveRunModelChange(): void {
  context.mocks.data.orgModelPolicies([
    buildModelPolicy({
      model: "claude-sonnet-4-6",
      modelLabel: "Claude Sonnet 4.6",
      isDefault: false,
    }),
    buildModelPolicy({
      model: "claude-opus-4-8",
      modelLabel: "Claude Opus 4.8",
    }),
  ]);
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    selectedModel: "claude-opus-4-8",
    activeRunIds: ["run-active"],
    chatEvents: [
      {
        id: `${THREAD_ID}-active-user`,
        role: "user",
        content: "Start the active run",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Start the active run" },
            { type: "model", selectedModel: "claude-sonnet-4-6" },
          ],
        },
        runId: "run-active",
        createdAt: "2026-08-06T10:00:00Z",
      },
      {
        id: `${THREAD_ID}-active-assistant`,
        role: "assistant",
        content: null,
        runId: "run-active",
        createdAt: "2026-08-06T10:00:01Z",
      },
      {
        id: `${THREAD_ID}-queued-user`,
        role: "user",
        content: null,
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Follow up after the active run" },
            { type: "morning_brief", briefDate: "2026-08-06" },
          ],
        },
        runId: undefined,
        createdAt: "2026-08-06T10:00:02Z",
      },
    ],
  });
}

function mockCompletedRunModelHistory({
  previousModel,
  nextModel,
}: {
  previousModel: string | undefined;
  nextModel: string | undefined;
}): void {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: `${THREAD_ID}-previous-user`,
        role: "user",
        content: "First prompt",
        userMessage: modelAnnotatedMessage("First prompt", previousModel),
        runId: "run-previous",
        createdAt: "2026-08-06T09:00:00Z",
      },
      {
        id: `${THREAD_ID}-previous-assistant`,
        role: "assistant",
        content: "First answer",
        runId: "run-previous",
        createdAt: "2026-08-06T09:00:01Z",
      },
      {
        id: `${THREAD_ID}-next-user`,
        role: "user",
        content: "Second prompt",
        userMessage: modelAnnotatedMessage("Second prompt", nextModel),
        runId: "run-next",
        createdAt: "2026-08-06T09:01:00Z",
      },
      {
        id: `${THREAD_ID}-next-assistant`,
        role: "assistant",
        content: "Second answer",
        runId: "run-next",
        createdAt: "2026-08-06T09:01:01Z",
      },
    ],
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
        content: null,
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Continue after recovery" },
            { type: "morning_brief", briefDate: "2026-07-30" },
          ],
        },
        runId: undefined,
        createdAt: "2026-07-30T10:00:02Z",
      },
      ...(options?.includeAutomation
        ? [
            {
              id: `${THREAD_ID}-queued-automation`,
              eventType: "input.automation" as const,
              content: null,
              userMessage: {
                version: 1 as const,
                parts: [
                  {
                    type: "automation" as const,
                    workflowName: "queued-workflow",
                    automationBrief: "Process the queued automation",
                  },
                ],
              },
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
  it("renders pending prompts inline", async () => {
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      activeRunIds: ["run-active"],
      chatEvents: [
        {
          id: `${THREAD_ID}-active-user`,
          role: "user",
          content: "Start the active run",
          runId: "run-active",
          createdAt: "2026-08-04T10:00:00Z",
        },
        {
          id: `${THREAD_ID}-active-assistant`,
          role: "assistant",
          content: "Working on the first request.",
          runId: "run-active",
          createdAt: "2026-08-04T10:00:01Z",
        },
        {
          id: `${THREAD_ID}-pending-prompt`,
          role: "user",
          content: "Steer this follow-up",
          runId: undefined,
          createdAt: "2026-08-04T10:00:02Z",
        },
        {
          id: `${THREAD_ID}-pending-morning-brief`,
          role: "user",
          content: null,
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Keep the morning brief queued" },
              { type: "morning_brief", briefDate: "2026-08-05" },
            ],
          },
          runId: undefined,
          createdAt: "2026-08-04T10:00:03Z",
        },
        {
          id: `${THREAD_ID}-pending-automation`,
          eventType: "input.automation",
          content: null,
          userMessage: {
            version: 1,
            parts: [
              {
                type: "automation",
                workflowName: "queued-workflow",
                automationBrief: "Keep this automation queued",
              },
            ],
          },
          runId: undefined,
          createdAt: "2026-08-04T10:00:04Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
    });

    await expect(
      screen.findByText("Steer this follow-up"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("Queued message")).toHaveTextContent(
      "Keep the morning brief queued",
    );
    expect(screen.getByLabelText("Queued message")).not.toHaveTextContent(
      "Steer this follow-up",
    );
    expect(screen.getByLabelText("Pending automation event")).toHaveTextContent(
      "Keep this automation queued",
    );
    expectTextBefore("Working on the first request.", "Steer this follow-up");
  });

  it("shows a selected model change at the bottom of the message area", async () => {
    mockActiveRunModelChange();

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.ChatNextRunModelNotice]: true },
      path: CHAT_PATH,
    });

    const label = await screen.findByText(NEXT_RUN_MODEL_COPY);
    const notice = label.closest('[role="status"]');
    expect(notice).toHaveAttribute("aria-live", "polite");
    expect(label).toHaveClass("text-right");
    expect(label.parentElement).toHaveClass("flex-row-reverse");
    expect(label.closest("[data-message-container]")).toBeInTheDocument();
    expectTextBefore("Start the active run", NEXT_RUN_MODEL_COPY);
    expectTextBefore(NEXT_RUN_MODEL_COPY, "1 message waiting");
    expectTextBefore(NEXT_RUN_MODEL_COPY, "Follow up after the active run");
  });

  it("keeps the model change notice hidden when its switch is off", async () => {
    mockActiveRunModelChange();

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.ChatNextRunModelNotice]: false },
      path: CHAT_PATH,
    });

    await expect(
      screen.findByText("Follow up after the active run"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText(NEXT_RUN_MODEL_COPY)).not.toBeInTheDocument();
  });

  it("inserts a model change divider between adjacent runs", async () => {
    mockCompletedRunModelHistory({
      previousModel: "gpt-5.5",
      nextModel: "claude-sonnet-4-6",
    });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.ChatNextRunModelNotice]: true },
      path: CHAT_PATH,
    });

    await expect(
      screen.findByText(MODEL_CHANGED_COPY),
    ).resolves.toBeInTheDocument();
    const label = screen.getByText(MODEL_CHANGED_COPY);
    expect(label).toHaveClass("text-right");
    expect(label.parentElement).toHaveClass("flex-row-reverse");
    expectTextBefore("First answer", MODEL_CHANGED_COPY);
    expectTextBefore(MODEL_CHANGED_COPY, "Second prompt");
  });

  it.each([
    {
      name: "the models match",
      previousModel: "claude-sonnet-4-6",
      nextModel: "claude-sonnet-4-6",
    },
    {
      name: "the previous run has no model",
      previousModel: undefined,
      nextModel: "claude-sonnet-4-6",
    },
    {
      name: "the next run has no model",
      previousModel: "gpt-5.5",
      nextModel: undefined,
    },
  ])("does not insert a model change divider when $name", async (models) => {
    mockCompletedRunModelHistory(models);

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.ChatNextRunModelNotice]: true },
      path: CHAT_PATH,
    });

    await expect(
      screen.findByText("Second prompt"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText(MODEL_CHANGED_COPY)).not.toBeInTheDocument();
  });

  it("keeps an optimistic steer prompt at the bottom until persistence", async () => {
    const user = userEvent.setup({ delay: null });
    const appendGate = context.mocks.deferred<void>();
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      activeRunIds: ["run-active"],
      appendGate: appendGate.promise,
      chatEvents: [
        {
          id: `${THREAD_ID}-active-user`,
          role: "user",
          content: "Start the active run",
          runId: "run-active",
          createdAt: "2026-08-04T10:00:00Z",
        },
        {
          id: `${THREAD_ID}-active-assistant`,
          role: "assistant",
          content: "Still working.",
          runId: "run-active",
          createdAt: "2026-08-04T10:00:01Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
    });

    await screen.findByText("Still working.");
    const submit = sendQueuedMessage(user, "Optimistic steer prompt");
    await expect(
      screen.findByText("Optimistic steer prompt"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
    expectTextBefore("Still working.", "Optimistic steer prompt");

    appendGate.resolve();
    await submit;
  });

  it("falls back to generic queue guidance for a previous API response", async () => {
    mockCancellationRecoveryQueue();
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
        cancellationRecoveryPending: false,
      });
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
        "Finalizando a execução cancelada antes de continuar o trabalho na fila.",
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
              { type: "morning_brief", briefDate: "2026-06-09" },
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

  it("renders a server-reconciled follow-up inline", async () => {
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
    await fill(composer, "Keep this follow-up");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(queuedBodies).toHaveLength(1);
      expect(screen.getByText("Keep this follow-up")).toBeInTheDocument();
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
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

  it("renders a video-only follow-up inline for a fallback-enabled text-only model", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000902";
    let queuedBody: QueuedMessageCapture | null = null;

    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        model: "glm-5.1",
        modelLabel: "GLM-5.1",
      }),
    ]);
    mockChatLifecycle(context, {
      threadId,
      selectedModel: "glm-5.1",
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
      id: "upload-queued-video",
      filename: "queued.mp4",
      contentType: "video/mp4",
      size: 12,
      url: "https://cdn.vm7.io/artifacts/test/upload-queued-video/queued.mp4",
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

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
      new File([new Uint8Array(12)], "queued.mp4", { type: "video/mp4" }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Remove queued.mp4")).toBeInTheDocument();
    });

    await user.click(await screen.findByLabelText("Send"));

    await waitFor(() => {
      expect(screen.getByLabelText("Preview queued.mp4")).toBeInTheDocument();
      expect(screen.queryByText("1 message waiting")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
      expect(queuedBody).toMatchObject({
        content: "(see attached files)",
        hasTextContent: false,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: "upload-queued-video",
              filenameSnapshot: "queued.mp4",
              contentType: "video/mp4",
            },
            { type: "model", selectedModel: "glm-5.1" },
          ],
        },
      });
    });
  });

  it("stops an active run after inline steering and clears the thinking indicator", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({ context, path: CHAT_PATH });

    await startActiveRun(user);
    await sendQueuedMessage(user, "First queued");
    await sendQueuedMessage(user, "Second queued");
    await waitFor(() => {
      expect(screen.getByText("First queued")).toBeInTheDocument();
      expect(screen.getByText("Second queued")).toBeInTheDocument();
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
    });

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
      expect(screen.getByText("First queued")).toBeInTheDocument();
      expect(screen.getByText("Second queued")).toBeInTheDocument();
    });
  });
});
