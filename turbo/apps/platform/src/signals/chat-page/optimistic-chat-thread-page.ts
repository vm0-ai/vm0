import { command, computed } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  chatMessagesContract,
  chatThreadsContract,
  type AttachFile,
  type ChatThreadEvent,
  type GenerationTemplateRequest,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { OrgModelPoliciesResponse } from "@vm0/api-contracts/contracts/model-providers";
import type { UserModelPreferenceResponse } from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { accept } from "../../lib/accept.ts";
import { nowDate } from "../../lib/time.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import {
  chatThreads$,
  currentChatThreadId$,
  reloadChatThreads$,
} from "../agent-chat.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { loadRightThread$ } from "./chat-thread-panes.ts";
import {
  clearArtifactSidebarParams,
  clearChatAutomationSidebarParams,
} from "../zero-page/right-sidebar-search-params.ts";
import { talkDraft$ } from "../zero-page/chat-draft.ts";
import { clearAgentDraftById$ } from "../zero-page/agent-draft.ts";
import {
  prepareUserMessageFromDraft$,
  shouldExcludeVisualAttachmentsForModel,
} from "./resolve-draft-attachments.ts";
import {
  appendOptimisticChatMessage$,
  type OptimisticChatMessageEntry,
} from "./optimistic-chat-messages.ts";
import { resolveModelFirstUserDefaultSelection } from "../zero-page/model-default-selection.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { userModelPreference$ } from "../external/user-model-preference.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { logger } from "../log.ts";
import {
  modelSelectionRequestFromSelection,
  runOptionsFromModelProviderSelection,
} from "./model-selection-request.ts";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import { registerOptimisticChatThreadEvent$ } from "./chat-thread-event-sourcing.ts";

export type NewChatThreadPane = "main" | "sidebar";

const SIDEBAR_PARAM = "sidebar";

const L = logger("NewChatThread");

export const newChatThreadDisabled$ = computed(() => {
  return false;
});

interface SendNewThreadMessageRequest {
  agentId: string;
  prompt: string;
  modelSelection: ModelProviderSelection | null;
  generationTemplate: GenerationTemplateRequest | undefined;
  computerUseHostId?: string | null;
}

interface SendNewThreadMessageResult {
  threadId: string;
  runId: string | null;
}

interface PreparedNewThreadPayload {
  prompt: string;
  attachFiles: AttachFile[] | undefined;
  attachments: PagedChatMessage["attachFiles"];
  hasTextContent: boolean;
}

function createNewThreadOptimisticMessageEntry({
  threadId,
  clientMessageId,
  prepared,
  generationTemplate,
}: {
  threadId: string;
  clientMessageId: string;
  prepared: PreparedNewThreadPayload;
  generationTemplate: GenerationTemplateRequest | undefined;
}): OptimisticChatMessageEntry {
  return {
    threadId,
    optimisticUserMessageAssociation: "run",
    message: {
      id: clientMessageId,
      role: "user",
      content: prepared.prompt,
      attachFiles: prepared.attachments,
      generationTemplate,
      createdAt: nowDate().toISOString(),
    },
  };
}

function newThreadSendBody({
  agentId,
  threadId,
  clientMessageId,
  prepared,
  modelSelection,
  codexFastModeEnabled,
  generationTemplate,
  computerUseHostId,
}: {
  agentId: string;
  threadId: string;
  clientMessageId: string;
  prepared: PreparedNewThreadPayload;
  modelSelection: ModelProviderSelection;
  codexFastModeEnabled: boolean;
  generationTemplate: GenerationTemplateRequest | undefined;
  computerUseHostId?: string | null;
}) {
  const runOptions = runOptionsFromModelProviderSelection(
    modelSelection,
    codexFastModeEnabled,
  );
  return {
    agentId,
    prompt: prepared.prompt,
    threadId,
    hasTextContent: prepared.hasTextContent,
    clientMessageId,
    ...(runOptions ? { runOptions } : {}),
    generationTemplate,
    ...(computerUseHostId === undefined ? {} : { computerUseHostId }),
    attachFiles: prepared.attachFiles,
  };
}

function codexFastModeSwitchEnabled(
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): boolean {
  return switches[FeatureSwitchKey.CodexFastMode] ?? false;
}

function resolveNewThreadModelSelection(
  modelSelection: ModelProviderSelection | null,
  args: {
    readonly policies: OrgModelPoliciesResponse | null | undefined;
    readonly userPreference: UserModelPreferenceResponse | null | undefined;
  },
): ModelProviderSelection | null {
  if (modelSelection) {
    return modelSelection;
  }
  return resolveModelFirstUserDefaultSelection({
    userPreference: args.userPreference,
    policies: args.policies,
  });
}

const settleNewThreadSend$ = command(
  async (
    { set },
    args: {
      readonly clearDraftResult: Promise<void>;
      readonly createResult: Promise<void>;
      readonly createClient: ZeroClientFactory;
      readonly body: ReturnType<typeof newThreadSendBody>;
    },
    signal: AbortSignal,
  ): Promise<SendNewThreadMessageResult> => {
    await Promise.all([args.clearDraftResult, args.createResult]);
    signal.throwIfAborted();

    const result = await accept(
      args.createClient(chatMessagesContract).send({
        body: args.body,
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    L.debug("sendNewThreadMessage$ POST chat/messages 201", {
      threadId: result.body.threadId,
      runId: result.body.runId,
    });
    set(reloadChatThreads$);
    return { threadId: result.body.threadId, runId: result.body.runId };
  },
);

const routeMainChatThread$ = command(({ get, set }, threadId: string) => {
  const next = new URLSearchParams(get(searchParams$));
  if (next.get(SIDEBAR_PARAM) === threadId) {
    next.delete(SIDEBAR_PARAM);
  }
  clearArtifactSidebarParams(next);
  clearChatAutomationSidebarParams(next);
  set(detachedNavigateTo$, "/chats/:threadId", {
    pathParams: { threadId },
    searchParams: next,
  });
});

const routeSidebarChatThread$ = command(
  async (
    { get, set },
    threadId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!get(currentChatThreadId$)) {
      return;
    }
    await set(loadRightThread$, threadId, signal);
  },
);

const routeChatThread$ = command(
  async (
    { set },
    {
      pane,
      threadId,
    }: {
      readonly pane: NewChatThreadPane;
      readonly threadId: string;
    },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();

    if (pane === "main") {
      set(routeMainChatThread$, threadId);
    } else {
      await set(routeSidebarChatThread$, threadId, signal);
    }
  },
);

const mintOptimisticThreadWithEvent$ = command(
  (
    { set },
    args: {
      readonly threadId: string;
      readonly eventId: string;
      readonly agentId: string;
      readonly selectedModel: string | null;
    },
    signal: AbortSignal,
  ): void => {
    signal.throwIfAborted();
    L.debug("optimistic thread minted", {
      threadId: args.threadId,
      agentId: args.agentId,
    });
    const createdAt = nowDate().toISOString();
    set(registerOptimisticChatThreadEvent$, {
      id: args.eventId,
      kind: "created",
      chatThreadId: args.threadId,
      agentId: args.agentId,
      title: null,
      selectedModel: args.selectedModel,
      createdAt,
    } satisfies ChatThreadEvent);
  },
);

async function createChatThread(args: {
  readonly createClient: ZeroClientFactory;
  readonly agentId: string;
  readonly signal: AbortSignal;
  readonly title: string | undefined;
  readonly clientThreadId: string;
  readonly eventId: string;
  readonly modelSelection: ModelProviderSelection;
}): Promise<void> {
  const client = args.createClient(chatThreadsContract);
  await accept(
    client.create({
      body: {
        agentId: args.agentId,
        clientThreadId: args.clientThreadId,
        eventId: args.eventId,
        modelSelection: modelSelectionRequestFromSelection(
          args.modelSelection,
        )!,
        ...(args.title ? { title: args.title } : {}),
      },
      fetchOptions: { signal: args.signal },
    }),
    [201],
  );
}

const startNewChatThreadCreate$ = command(
  async (
    { get, set },
    agentId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly threadId: string;
    readonly createResult: Promise<void>;
  }> => {
    const threadId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const policies = await get(orgModelPolicies$);
    signal.throwIfAborted();
    const userPreference = await get(userModelPreference$);
    signal.throwIfAborted();
    const modelSelection = resolveNewThreadModelSelection(null, {
      policies,
      userPreference,
    });
    if (!modelSelection) {
      throw new Error("A model selection is required");
    }
    await set(
      mintOptimisticThreadWithEvent$,
      {
        threadId,
        eventId,
        agentId,
        selectedModel: modelSelection.selectedModel,
      },
      signal,
    );

    const createClient = get(zeroClient$);
    L.debug("startNewChatThreadCreate$ POST chat-threads start", { threadId });
    const createResult = (async (): Promise<void> => {
      await createChatThread({
        createClient,
        agentId,
        signal,
        title: undefined,
        clientThreadId: threadId,
        eventId,
        modelSelection,
      });
      L.debug("startNewChatThreadCreate$ POST chat-threads 201", { threadId });
      signal.throwIfAborted();
    })();

    return { threadId, createResult };
  },
);

export const createNewChatThread$ = command(
  async (
    { get, set },
    agentId: string,
    pane: NewChatThreadPane,
    signal: AbortSignal,
  ) => {
    const targetPane =
      pane === "sidebar" && get(currentChatThreadId$) ? "sidebar" : "main";
    const result = await set(startNewChatThreadCreate$, agentId, signal);

    await set(
      routeChatThread$,
      { pane: targetPane, threadId: result.threadId },
      signal,
    );
    await result.createResult;
  },
);

export const sidebarChatThreads$ = chatThreads$;

const sendNewThreadMessage$ = command(
  async (
    { get, set },
    request: SendNewThreadMessageRequest,
    signal: AbortSignal,
  ): Promise<{
    readonly threadId: string;
    readonly sendResult: Promise<SendNewThreadMessageResult>;
  } | null> => {
    const { agentId, prompt, modelSelection, generationTemplate } = request;
    const { computerUseHostId } = request;
    const draft = get(talkDraft$);
    const policies = await get(orgModelPolicies$);
    signal.throwIfAborted();
    const userPreference = await get(userModelPreference$);
    signal.throwIfAborted();
    const resolvedModelSelection = resolveNewThreadModelSelection(
      modelSelection,
      {
        policies,
        userPreference,
      },
    );
    if (!resolvedModelSelection) {
      throw new Error("A model selection is required");
    }
    const prepared = await set(
      prepareUserMessageFromDraft$,
      draft,
      prompt,
      {
        excludeVisualAttachments: shouldExcludeVisualAttachmentsForModel(
          resolvedModelSelection.selectedModel,
        ),
      },
      signal,
    );
    if (!prepared) {
      return null;
    }
    const threadId = crypto.randomUUID();
    const clientMessageId = crypto.randomUUID();
    const chatThreadEventId = crypto.randomUUID();
    set(
      appendOptimisticChatMessage$,
      createNewThreadOptimisticMessageEntry({
        threadId,
        clientMessageId,
        prepared,
        generationTemplate,
      }),
    );
    await set(
      mintOptimisticThreadWithEvent$,
      {
        threadId,
        eventId: chatThreadEventId,
        agentId,
        selectedModel: resolvedModelSelection.selectedModel,
      },
      signal,
    );
    set(draft.clear$);
    const clearDraftResult = set(clearAgentDraftById$, agentId, signal);
    const createClient = get(zeroClient$);
    L.debug("sendNewThreadMessage$ POST chat-threads start", { threadId });
    const createResult = (async (): Promise<void> => {
      await createChatThread({
        createClient,
        agentId,
        signal,
        title: undefined,
        clientThreadId: threadId,
        eventId: chatThreadEventId,
        modelSelection: resolvedModelSelection,
      });
      L.debug("sendNewThreadMessage$ POST chat-threads 201", { threadId });
      signal.throwIfAborted();
    })();
    const sendResult = set(
      settleNewThreadSend$,
      {
        clearDraftResult,
        createResult,
        createClient,
        body: newThreadSendBody({
          agentId,
          threadId,
          clientMessageId,
          prepared,
          modelSelection: resolvedModelSelection,
          codexFastModeEnabled: codexFastModeSwitchEnabled(get(featureSwitch$)),
          generationTemplate,
          computerUseHostId,
        }),
      },
      signal,
    );
    return { threadId, sendResult };
  },
);

export const sendNewThread$ = command(
  async (
    { set },
    request: SendNewThreadMessageRequest,
    signal: AbortSignal,
  ) => {
    const result = await set(sendNewThreadMessage$, request, signal);
    if (!result) {
      return;
    }

    await set(
      routeChatThread$,
      { pane: "main", threadId: result.threadId },
      signal,
    );
    await result.sendResult;
  },
);
