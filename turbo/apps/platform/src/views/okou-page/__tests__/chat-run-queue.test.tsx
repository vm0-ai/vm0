import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  chatThreadByIdContract,
  chatThreadsContract,
  type ChatRunOptionsRequest,
  type ChatThreadServiceTier,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type {
  ModelProviderResponse,
  OrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { triggerAblyEvent, triggerAblyReconnect } from "../../../mocks/ably.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
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
const NEXT_RUN_SONNET_MODEL_COPY = "Next run will use Claude Sonnet 4.6";
const MODEL_CHANGED_COPY = "Model changed to Claude Sonnet 4.6";
const FAST_MODEL_CHANGED_COPY = "Model changed to GPT 5.6 Sol Fast";
const NEXT_RUN_FAST_MODEL_COPY = "Next run will use GPT 5.6 Sol Fast";
const RECONCILED_THREAD_TITLE = "Reconciled thread";

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
    defaultProviderType: "built-in",
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
  serviceTier?: ChatThreadServiceTier,
): UserMessageDocument {
  return {
    version: 1,
    parts: [
      { type: "text", text },
      ...(selectedModel === undefined
        ? []
        : [
            {
              type: "model" as const,
              selectedModel,
              ...(serviceTier === undefined ? {} : { serviceTier }),
            },
          ]),
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
    ],
  });
}

function mockActiveRunFastSelectionChange({
  runningModel,
  runningServiceTier,
  selectedModel,
  selectedServiceTier,
}: {
  readonly runningModel: "gpt-5.5" | "gpt-5.6-sol";
  readonly runningServiceTier?: ChatThreadServiceTier;
  readonly selectedModel: "gpt-5.5" | "gpt-5.6-sol";
  readonly selectedServiceTier?: ChatThreadServiceTier;
}): void {
  context.mocks.data.orgModelPolicies([
    buildModelPolicy({
      model: "gpt-5.6-sol",
      modelLabel: "GPT 5.6 Sol",
      defaultProviderType: "codex-oauth-token",
      credentialScope: "member",
    }),
    buildModelPolicy({
      model: "gpt-5.5",
      modelLabel: "GPT 5.5",
      defaultProviderType: "codex-oauth-token",
      credentialScope: "member",
      isDefault: false,
    }),
  ]);
  context.mocks.data.personalModelProviders([
    buildProvider({
      id: "00000000-0000-4000-a000-000000000932",
      type: "codex-oauth-token",
    }),
  ]);
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    selectedModel,
    codexServiceTier: selectedServiceTier === "priority" ? "fast" : null,
    activeRunIds: ["run-active"],
    chatEvents: [
      {
        id: `${THREAD_ID}-active-user`,
        role: "user",
        content: "Start the active run",
        userMessage: modelAnnotatedMessage(
          "Start the active run",
          runningModel,
          runningServiceTier,
        ),
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
    ],
  });
}

function mockCompletedRunModelHistory({
  previousModel,
  nextModel,
  previousServiceTier,
  nextServiceTier,
}: {
  previousModel: string | undefined;
  nextModel: string | undefined;
  previousServiceTier?: ChatThreadServiceTier;
  nextServiceTier?: ChatThreadServiceTier;
}): void {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: `${THREAD_ID}-previous-user`,
        role: "user",
        content: "First prompt",
        userMessage: modelAnnotatedMessage(
          "First prompt",
          previousModel,
          previousServiceTier,
        ),
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
        userMessage: modelAnnotatedMessage(
          "Second prompt",
          nextModel,
          nextServiceTier,
        ),
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
        id: `${THREAD_ID}-queued-automation`,
        eventType: "input.automation",
        content: null,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "automation",
              workflowName: "queued-workflow",
              automationBrief: "Process the queued automation",
            },
          ],
        },
        runId: undefined,
        createdAt: "2026-07-30T10:00:02Z",
      },
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
          createdAt: "2026-08-04T10:00:03Z",
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
    expect(screen.getByLabelText("Pending automation event")).toHaveTextContent(
      "Keep this automation queued",
    );
    expectTextBefore("Working on the first request.", "Steer this follow-up");
  });

  it("shows a selected model change at the bottom of the message area", async () => {
    mockActiveRunModelChange();

    detachedSetupPage({
      context,
      path: CHAT_PATH,
    });

    const label = await screen.findByText(NEXT_RUN_MODEL_COPY);
    const notice = label.closest('[role="status"]');
    expect(notice).toHaveAttribute("aria-live", "polite");
    expect(label.closest("[data-message-container]")).toBeInTheDocument();
    expectTextBefore("Start the active run", NEXT_RUN_MODEL_COPY);
  });

  it.each([
    {
      name: "the target model also changes",
      runningModel: "gpt-5.5",
      runningServiceTier: undefined,
      selectedModel: "gpt-5.6-sol",
      selectedServiceTier: "priority",
      expectedCopy: NEXT_RUN_FAST_MODEL_COPY,
      absentCopy: "Fast mode will be on",
    },
    {
      name: "Fast mode turns on for the same model",
      runningModel: "gpt-5.6-sol",
      runningServiceTier: undefined,
      selectedModel: "gpt-5.6-sol",
      selectedServiceTier: "priority",
      expectedCopy: "Fast mode will be on",
      absentCopy: NEXT_RUN_FAST_MODEL_COPY,
    },
    {
      name: "Fast mode turns off for the same model",
      runningModel: "gpt-5.6-sol",
      runningServiceTier: "priority",
      selectedModel: "gpt-5.6-sol",
      selectedServiceTier: undefined,
      expectedCopy: "Fast mode will be off",
      absentCopy: NEXT_RUN_FAST_MODEL_COPY,
    },
  ] as const)(
    "shows the next-run Fast change when $name",
    async (selection) => {
      mockActiveRunFastSelectionChange(selection);

      detachedSetupPage({
        context,
        featureSwitches: { [FeatureSwitchKey.CodexFastMode]: true },
        path: CHAT_PATH,
      });

      const label = await screen.findByText(selection.expectedCopy);
      expect(label.closest('[role="status"]')).toHaveAttribute(
        "aria-live",
        "polite",
      );
      expect(screen.queryByText(selection.absentCopy)).not.toBeInTheDocument();
    },
  );

  it("inserts a model change divider between adjacent runs", async () => {
    mockCompletedRunModelHistory({
      previousModel: "gpt-5.5",
      nextModel: "claude-sonnet-4-6",
    });

    detachedSetupPage({
      context,
      path: CHAT_PATH,
    });

    await expect(
      screen.findByText(MODEL_CHANGED_COPY),
    ).resolves.toBeInTheDocument();
    expectTextBefore("First answer", MODEL_CHANGED_COPY);
    expectTextBefore(MODEL_CHANGED_COPY, "Second prompt");
  });

  it.each([
    {
      name: "includes Fast in a changed model name",
      previousModel: "gpt-5.5",
      previousServiceTier: undefined,
      nextModel: "gpt-5.6-sol",
      nextServiceTier: "priority",
      expectedCopy: FAST_MODEL_CHANGED_COPY,
      absentCopy: "Fast mode on",
    },
    {
      name: "marks Fast mode on for the same model",
      previousModel: "gpt-5.6-sol",
      previousServiceTier: undefined,
      nextModel: "gpt-5.6-sol",
      nextServiceTier: "priority",
      expectedCopy: "Fast mode on",
      absentCopy: FAST_MODEL_CHANGED_COPY,
    },
    {
      name: "marks Fast mode off for the same model",
      previousModel: "gpt-5.6-sol",
      previousServiceTier: "priority",
      nextModel: "gpt-5.6-sol",
      nextServiceTier: undefined,
      expectedCopy: "Fast mode off",
      absentCopy: FAST_MODEL_CHANGED_COPY,
    },
  ] as const)(
    "renders the historical Fast transition when it $name",
    async (change) => {
      mockCompletedRunModelHistory(change);

      detachedSetupPage({
        context,
        path: CHAT_PATH,
      });

      await expect(
        screen.findByText(change.expectedCopy),
      ).resolves.toBeInTheDocument();
      expectTextBefore("First answer", change.expectedCopy);
      expectTextBefore(change.expectedCopy, "Second prompt");
      expect(screen.queryByText(change.absentCopy)).not.toBeInTheDocument();
    },
  );

  it("inserts a model change divider before an optimistic run reconciles", async () => {
    const user = userEvent.setup({ delay: null });
    const secondSendGate = context.mocks.deferred<void>();
    let sendCount = 0;
    let clientThreadId: string | undefined;
    let threadCreateEventId: string | undefined;
    let secondUserMessage: UserMessageDocument | undefined;
    context.mocks.data.userModelPreference({
      selectedModel: "gpt-5.5",
      serviceTier: null,
      updatedAt: "2026-08-06T09:00:00Z",
    });
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        model: "gpt-5.5",
        modelLabel: "GPT 5.5",
      }),
      buildModelPolicy({
        model: "claude-sonnet-4-6",
        modelLabel: "Claude Sonnet 4.6",
        isDefault: false,
      }),
    ]);
    const lifecycle = mockChatLifecycle(context, {
      sendGate: () => {
        sendCount++;
        return sendCount === 2
          ? secondSendGate.promise
          : Promise.resolve(undefined);
      },
      onSendRequest: ({ prompt, userMessage }) => {
        if (prompt === "Second prompt") {
          secondUserMessage = userMessage;
        }
      },
      onThreadCreate: (body) => {
        clientThreadId = body.clientThreadId;
        threadCreateEventId = body.eventId;
      },
    });

    detachedSetupPage({
      context,
      path: AGENT_CHAT_PATH,
    });

    await sendMessageInUI(
      user,
      (await screen.findByPlaceholderText(PLACEHOLDER)) as HTMLTextAreaElement,
      "First prompt",
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
    const settledThreadId = clientThreadId;
    const settledThreadCreateEventId = threadCreateEventId;
    if (
      settledThreadId === undefined ||
      settledThreadCreateEventId === undefined
    ) {
      throw new Error("Expected the optimistic thread create identifiers");
    }

    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, {
        events: [
          {
            id: settledThreadCreateEventId,
            seqId: 1,
            kind: "created",
            chatThreadId: settledThreadId,
            agentId: AGENT_ID,
            title: RECONCILED_THREAD_TITLE,
            selectedModel: "gpt-5.5",
            serviceTier: null,
            computerUseHostId: null,
            cloudBrowserEnabled: true,
            createdAt: "2026-08-06T09:00:00Z",
          },
        ],
        hasMore: false,
      });
    });
    changeChatThreadList();
    await waitFor(() => {
      expect(document.title).toBe(`${RECONCILED_THREAD_TITLE} | VM0`);
    });

    lifecycle.completeRun("First answer");
    await waitFor(() => {
      expect(screen.getByText("First answer")).toBeInTheDocument();
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });

    await user.click(await screen.findByRole("combobox", { name: "GPT 5.5" }));
    await user.click(
      await screen.findByRole("option", { name: /Claude Sonnet 4\.6/ }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Claude Sonnet 4.6" }),
      ).toBeInTheDocument();
    });

    await fill(
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Second prompt",
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeEnabled();
    });
    await user.click(screen.getByLabelText("Send"));

    await expect(
      screen.findByText("Second prompt"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(secondUserMessage?.parts).toContainEqual({
        type: "model",
        selectedModel: "claude-sonnet-4-6",
      });
    });
    expect(secondSendGate.settled()).toBeFalsy();
    expect(screen.getByText(MODEL_CHANGED_COPY)).toBeInTheDocument();
    expectTextBefore("First answer", MODEL_CHANGED_COPY);
    expectTextBefore(MODEL_CHANGED_COPY, "Second prompt");
  });

  it("annotates an optimistic Fast run and sends the service tier", async () => {
    const user = userEvent.setup({ delay: null });
    const sendGate = context.mocks.deferred<void>();
    let requestUserMessage: UserMessageDocument | undefined;
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        model: "gpt-5.6-sol",
        modelLabel: "GPT 5.6 Sol",
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([
      buildProvider({
        id: "00000000-0000-4000-a000-000000000933",
        type: "codex-oauth-token",
      }),
    ]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "gpt-5.6-sol",
      codexServiceTier: "fast",
      sendGate: sendGate.promise,
      onSendRequest: ({ userMessage }) => {
        requestUserMessage = userMessage;
      },
      chatEvents: [
        {
          id: `${THREAD_ID}-previous-user`,
          role: "user",
          content: "First prompt",
          userMessage: modelAnnotatedMessage("First prompt", "gpt-5.6-sol"),
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
      ],
    });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.CodexFastMode]: true },
      path: CHAT_PATH,
    });

    await fill(
      (await screen.findByPlaceholderText(PLACEHOLDER)) as HTMLTextAreaElement,
      "Second prompt",
    );
    await user.click(screen.getByLabelText("Send"));

    await expect(
      screen.findByText("Fast mode on"),
    ).resolves.toBeInTheDocument();
    expectTextBefore("First answer", "Fast mode on");
    expectTextBefore("Fast mode on", "Second prompt");
    await waitFor(() => {
      expect(
        requestUserMessage?.parts.find((part) => {
          return part.type === "model";
        }),
      ).toStrictEqual({
        type: "model",
        selectedModel: "gpt-5.6-sol",
        serviceTier: "priority",
      });
    });
    expect(sendGate.settled()).toBeFalsy();
  });

  it("keeps a model change pending through a steer before showing the next run divider optimistically", async () => {
    const user = userEvent.setup({ delay: null });
    const nextRunSendGate = context.mocks.deferred<void>();
    const steerMessages: QueuedMessageCapture[] = [];
    let runCreateCount = 0;
    let nextRunUserMessage: UserMessageDocument | undefined;
    context.mocks.data.userModelPreference({
      selectedModel: "gpt-5.5",
      serviceTier: null,
      updatedAt: "2026-08-06T09:00:00Z",
    });
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        model: "gpt-5.5",
        modelLabel: "GPT 5.5",
      }),
      buildModelPolicy({
        model: "claude-sonnet-4-6",
        modelLabel: "Claude Sonnet 4.6",
        isDefault: false,
      }),
    ]);
    const lifecycle = mockChatLifecycle(context, {
      threadId: THREAD_ID,
      selectedModel: "gpt-5.5",
      sendGate: () => {
        runCreateCount++;
        return runCreateCount === 2
          ? nextRunSendGate.promise
          : Promise.resolve(undefined);
      },
      onQueuedEventAppend: (body) => {
        steerMessages.push(body);
      },
      onSendRequest: ({ prompt, userMessage }) => {
        if (prompt === "Start the model B run") {
          nextRunUserMessage = userMessage;
        }
      },
    });
    detachedSetupPage({
      context,
      path: CHAT_PATH,
    });

    await sendMessageInUI(
      user,
      (await screen.findByPlaceholderText(PLACEHOLDER)) as HTMLTextAreaElement,
      "Start the model A run",
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
    lifecycle.setRunOutput("Working with model A.");
    await waitFor(() => {
      expect(screen.getByText("Working with model A.")).toBeInTheDocument();
    });

    await user.click(await screen.findByRole("combobox", { name: "GPT 5.5" }));
    await user.click(
      await screen.findByRole("option", { name: /Claude Sonnet 4\.6/ }),
    );
    await expect(
      screen.findByText(NEXT_RUN_SONNET_MODEL_COPY),
    ).resolves.toBeInTheDocument();

    await sendQueuedMessage(user, "Steer the model A run");
    await expect(
      screen.findByText("Steer the model A run"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(steerMessages).toHaveLength(1);
    });
    expect(
      steerMessages[0]?.userMessage?.parts.find((part) => {
        return part.type === "model";
      }),
    ).toBeUndefined();
    expect(screen.getByText(NEXT_RUN_SONNET_MODEL_COPY)).toBeInTheDocument();
    expect(screen.queryByText(MODEL_CHANGED_COPY)).not.toBeInTheDocument();
    // The pending next-run model change keeps the established divider treatment.
    expect(
      screen
        .getByText(NEXT_RUN_SONNET_MODEL_COPY)
        .closest("div")
        ?.querySelector('[role="separator"]'),
    ).not.toBeNull();

    lifecycle.completeRun("Model A finished.");
    await waitFor(() => {
      expect(screen.getByText("Model A finished.")).toBeInTheDocument();
      expect(
        screen.queryByText(NEXT_RUN_SONNET_MODEL_COPY),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });

    await fill(
      screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      "Start the model B run",
    );
    await user.click(screen.getByLabelText("Send"));

    await expect(
      screen.findByText("Start the model B run"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(nextRunUserMessage?.parts).toContainEqual({
        type: "model",
        selectedModel: "claude-sonnet-4-6",
      });
    });
    expect(nextRunSendGate.settled()).toBeFalsy();
    expect(screen.getByText(MODEL_CHANGED_COPY)).toBeInTheDocument();
    // The model change is a permanent mark on the transcript, so it keeps one.
    expect(
      screen
        .getByText(MODEL_CHANGED_COPY)
        .closest("div")
        ?.querySelector('[role="separator"]'),
    ).not.toBeNull();
    expectTextBefore("Model A finished.", MODEL_CHANGED_COPY);
    expectTextBefore(MODEL_CHANGED_COPY, "Start the model B run");
  });

  it.each([
    {
      name: "the models match",
      previousModel: "claude-sonnet-4-6",
      nextModel: "claude-sonnet-4-6",
    },
    {
      name: "the models and Fast tiers match",
      previousModel: "gpt-5.6-sol",
      previousServiceTier: "priority" as const,
      nextModel: "gpt-5.6-sol",
      nextServiceTier: "priority" as const,
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
      path: CHAT_PATH,
    });

    await expect(
      screen.findByText("Second prompt"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText(MODEL_CHANGED_COPY)).not.toBeInTheDocument();
    expect(screen.queryByText("Fast mode on")).not.toBeInTheDocument();
    expect(screen.queryByText("Fast mode off")).not.toBeInTheDocument();
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

  it("falls back to generic automation guidance for a previous API response", async () => {
    mockCancellationRecoveryQueue();
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
        cancellationRecoveryPending: false,
      });
    });

    detachedSetupPage({ context, path: CHAT_PATH });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Pending automation event"),
      ).toHaveTextContent("Process the queued automation");
    });
    expect(
      screen.queryByText(CANCELLATION_RECOVERY_COPY),
    ).not.toBeInTheDocument();

    click(screen.getByLabelText("About this automation event"));
    await expect(
      screen.findByText(
        "Waits behind queued messages and runs once the current run finishes.",
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
      screen.findByLabelText("Pending automation event"),
    ).resolves.toHaveTextContent("Process the queued automation");
    expect(
      screen.queryByText(CANCELLATION_RECOVERY_COPY),
    ).not.toBeInTheDocument();
  });

  it("explains recovery without disabling queued work or the composer", async () => {
    const recalledEventIds: string[] = [];
    mockCancellationRecoveryQueue({
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
    expect(screen.getByLabelText("Pending automation event")).toHaveTextContent(
      "Process the queued automation",
    );
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();

    click(screen.getByLabelText("About this automation event"));
    await waitFor(() => {
      expect(screen.getAllByText(CANCELLATION_RECOVERY_COPY)).toHaveLength(2);
    });
    fireEvent.keyDown(document, { key: "Escape" });

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
      expect(
        screen.getByLabelText("Pending automation event"),
      ).toBeInTheDocument();
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
        model: "gpt-5.6-luna",
        modelLabel: "GPT 5.6 Luna",
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
      selectedModel: "gpt-5.6-luna",
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
        model: "deepseek-v4-flash",
        modelLabel: "DeepSeek V4 Flash",
      }),
    ]);
    mockChatLifecycle(context, {
      threadId,
      selectedModel: "deepseek-v4-flash",
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
