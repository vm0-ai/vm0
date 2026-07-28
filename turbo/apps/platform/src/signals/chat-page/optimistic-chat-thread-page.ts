import { command, computed } from "ccstate";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import {
  chatThreadModelSelectionContract,
  chatThreadsContract,
  type AttachFile,
  type GenerationTemplateRequest,
  type ChatPromptEvent,
  type UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { OrgModelPoliciesResponse } from "@vm0/api-contracts/contracts/model-providers";
import type { UserModelPreferenceResponse } from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { accept } from "../../lib/accept.ts";
import { startChatNavigationTiming$ } from "../../lib/posthog.ts";
import { nowDate } from "../../lib/time.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { loadRightThread$ } from "./chat-thread-panes.ts";
import {
  clearArtifactSidebarParams,
  clearBrowserSessionSidebarParams,
  clearChatAutomationSidebarParams,
  clearMailDraftSidebarParams,
} from "../zero-page/right-sidebar-search-params.ts";
import { talkDraft$ } from "../zero-page/chat-draft.ts";
import { clearAgentDraftById$ } from "../zero-page/agent-draft.ts";
import {
  prepareUserMessageFromDraft$,
  shouldExcludeVisualAttachmentsForModel,
} from "./resolve-draft-attachments.ts";
import {
  appendOptimisticChatMessage$,
  createOptimisticChatMessageEntry,
  type OptimisticChatMessageInput,
} from "./optimistic-chat-messages.ts";
import { sendChatEvent } from "./chat-event-api.ts";
import {
  applyCodexFastModeDefault,
  isCodexFastModeAvailableForSelection,
  resolveModelFirstUserDefaultSelection,
} from "../zero-page/model-default-selection.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { userModelPreference$ } from "../external/user-model-preference.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { codexFastModeLocalDefault$ } from "../zero-page/codex-fast-local-default.ts";
import { logger } from "../log.ts";
import { runOptionsFromModelProviderSelection } from "./model-selection-request.ts";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import { registerOptimisticChatThreadEvent$ } from "./chat-thread-event-sourcing.ts";
import { chatPageModelSelection$ } from "../zero-page/zero-chat-page.ts";
import { selectedModelAvailable$ } from "../zero-page/model-first-personal-oauth.ts";
import type { OptimisticChatThreadEvent } from "./chat-thread-event-types.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  textToMessageDocument,
  type EditorDocumentSnapshot,
} from "../zero-page/user-message-document-codec.ts";

export type NewChatThreadPane = "main" | "sidebar";

const SIDEBAR_PARAM = "sidebar";

const L = logger("NewChatThread");

export const newChatThreadDisabled$ = computed(() => {
  return false;
});

interface SendNewThreadMessageRequest {
  agentId: string;
  prompt: string;
  generationTemplate: GenerationTemplateRequest | undefined;
  generationTemplateTitleSnapshot?: string;
  editorDocument?: EditorDocumentSnapshot;
  computerUseHostId?: string | null;
  cloudBrowserEnabled?: boolean;
  routeSearchParams?: URLSearchParams;
}

interface SendNewThreadMessageResult {
  threadId: string;
  runId: string | null;
}

interface PreparedNewThreadPayload {
  prompt: string;
  attachFiles: AttachFile[] | undefined;
  attachments: ChatPromptEvent["attachFiles"];
  hasTextContent: boolean;
}

function userMessageForNewThread(
  request: SendNewThreadMessageRequest,
  prepared: PreparedNewThreadPayload,
): UserMessageDocument {
  const generationTemplate = request.generationTemplate;
  if (
    generationTemplate &&
    !request.editorDocument &&
    !request.generationTemplateTitleSnapshot
  ) {
    throw new Error("User-message template title snapshot is required");
  }
  const userMessage = request.editorDocument
    ? request.editorDocument.toMessageDocument({
        generationTemplate,
        attachments: prepared.attachments,
      })
    : textToMessageDocument(
        prepared.prompt,
        generationTemplate && request.generationTemplateTitleSnapshot
          ? {
              titleSnapshot: request.generationTemplateTitleSnapshot,
              template: generationTemplate,
            }
          : undefined,
        prepared.attachments,
      );
  if (!userMessage) {
    throw new Error("Failed to serialize user message");
  }
  return userMessage;
}

function createNewThreadOptimisticMessageEntry({
  threadId,
  clientEventId,
  prepared,
  generationTemplate,
  userMessage,
}: {
  threadId: string;
  clientEventId: string;
  prepared: PreparedNewThreadPayload;
  generationTemplate: GenerationTemplateRequest | undefined;
  userMessage: UserMessageDocument;
}): OptimisticChatMessageInput {
  return {
    threadId,
    optimisticUserMessageAssociation: "run",
    message: {
      id: clientEventId,
      threadId,
      eventType: "input.prompt",
      content: prepared.prompt,
      attachFiles: prepared.attachments,
      generationTemplate,
      userMessage,
      createdAt: nowDate().toISOString(),
    },
  };
}

function newThreadSendBody({
  agentId,
  threadId,
  clientEventId,
  prepared,
  modelSelection,
  codexFastModeEnabled,
  realAgentInPreviewEnabled,
  generationTemplate,
  userMessage,
  computerUseHostId,
  cloudBrowserEnabled,
}: {
  agentId: string;
  threadId: string;
  clientEventId: string;
  prepared: PreparedNewThreadPayload;
  modelSelection: ModelProviderSelection;
  codexFastModeEnabled: boolean;
  realAgentInPreviewEnabled: boolean;
  generationTemplate: GenerationTemplateRequest | undefined;
  userMessage: UserMessageDocument;
  computerUseHostId?: string | null;
  cloudBrowserEnabled?: boolean;
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
    clientEventId: clientEventId,
    ...(runOptions ? { runOptions } : {}),
    ...(realAgentInPreviewEnabled ? { realAgentInPreview: true } : {}),
    generationTemplate,
    userMessage,
    ...(computerUseHostId === undefined ? {} : { computerUseHostId }),
    ...(cloudBrowserEnabled === undefined ? {} : { cloudBrowserEnabled }),
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
    readonly codexFastModeDefault: boolean;
    readonly codexFastModeEnabled: boolean;
  },
): ModelProviderSelection | null {
  if (modelSelection) {
    return modelSelection.codexServiceTier === "fast" &&
      !isCodexFastModeAvailableForSelection({
        policies: args.policies,
        selectedModel: modelSelection.selectedModel,
        codexFastModeEnabled: args.codexFastModeEnabled,
      })
      ? { selectedModel: modelSelection.selectedModel }
      : modelSelection;
  }
  return applyCodexFastModeDefault({
    selection: resolveModelFirstUserDefaultSelection({
      userPreference: args.userPreference,
      policies: args.policies,
    }),
    policies: args.policies,
    codexFastModeEnabled: args.codexFastModeEnabled,
    codexFastModeDefault: args.codexFastModeDefault,
  });
}

const resolveCurrentNewThreadModelSelection$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const [modelSelection, policies, userPreference, codexFastModeDefault] =
      await Promise.all([
        get(chatPageModelSelection$),
        get(orgModelPolicies$),
        get(userModelPreference$),
        get(codexFastModeLocalDefault$),
      ]);
    signal.throwIfAborted();
    const featureSwitches = get(featureSwitch$);
    const resolved = resolveNewThreadModelSelection(modelSelection, {
      policies,
      userPreference,
      codexFastModeDefault,
      codexFastModeEnabled:
        featureSwitches[FeatureSwitchKey.CodexFastMode] ?? false,
    });
    if (
      resolved &&
      (await set(selectedModelAvailable$, resolved.selectedModel, signal))
    ) {
      return resolved;
    }
    toast.error("The selected model is not available");
    return null;
  },
);

const routeMainChatThread$ = command(
  (
    { get, set },
    args: {
      readonly threadId: string;
      readonly searchParams?: URLSearchParams;
    },
  ) => {
    const next = new URLSearchParams(args.searchParams ?? get(searchParams$));
    if (next.get(SIDEBAR_PARAM) === args.threadId) {
      next.delete(SIDEBAR_PARAM);
    }
    clearArtifactSidebarParams(next);
    clearChatAutomationSidebarParams(next);
    clearMailDraftSidebarParams(next);
    clearBrowserSessionSidebarParams(next);
    set(detachedNavigateTo$, "/chats/:threadId", {
      pathParams: { threadId: args.threadId },
      searchParams: next,
    });
  },
);

const routeSidebarChatThread$ = command(
  ({ get, set }, threadId: string): void => {
    if (!get(currentChatThreadId$)) {
      return;
    }
    set(loadRightThread$, threadId);
  },
);

const routeChatThread$ = command(
  async (
    { set },
    {
      pane,
      threadId,
      searchParams,
    }: {
      readonly pane: NewChatThreadPane;
      readonly threadId: string;
      readonly searchParams?: URLSearchParams;
    },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();

    if (pane === "main") {
      set(routeMainChatThread$, {
        threadId,
        ...(searchParams ? { searchParams } : {}),
      });
    } else {
      await set(routeSidebarChatThread$, threadId);
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
      readonly serviceTier: "priority" | null;
      readonly computerUseHostId: string | null;
      readonly cloudBrowserEnabled: boolean;
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
      serviceTier: args.serviceTier,
      computerUseHostId: args.computerUseHostId,
      cloudBrowserEnabled: args.cloudBrowserEnabled,
      createdAt,
    } satisfies OptimisticChatThreadEvent);
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
        model: args.modelSelection.selectedModel,
        ...(args.title ? { title: args.title } : {}),
      },
      fetchOptions: { signal: args.signal },
    }),
    [201],
  );
  args.signal.throwIfAborted();
  if (args.modelSelection.codexServiceTier === "fast") {
    const modelSelectionClient = args.createClient(
      chatThreadModelSelectionContract,
    );
    await accept(
      modelSelectionClient.update({
        params: { id: args.clientThreadId },
        body: {
          model: args.modelSelection.selectedModel,
          codexServiceTier: "fast",
          eventId: crypto.randomUUID(),
        },
        fetchOptions: { signal: args.signal },
      }),
      [204],
    );
  }
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
    const codexFastModeDefault = await get(codexFastModeLocalDefault$);
    signal.throwIfAborted();
    const featureSwitches = get(featureSwitch$);
    const modelSelection = resolveNewThreadModelSelection(null, {
      policies,
      userPreference,
      codexFastModeDefault,
      codexFastModeEnabled:
        featureSwitches[FeatureSwitchKey.CodexFastMode] ?? false,
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
        serviceTier:
          modelSelection.codexServiceTier === "fast" ? "priority" : null,
        computerUseHostId: null,
        cloudBrowserEnabled: false,
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

const sendNewThreadMessage$ = command(
  async (
    { get, set },
    request: SendNewThreadMessageRequest,
    signal: AbortSignal,
  ): Promise<{
    readonly threadId: string;
    readonly sendResult: Promise<SendNewThreadMessageResult>;
  } | null> => {
    const { agentId, prompt } = request;
    const generationTemplate = request.generationTemplate;
    const { computerUseHostId, cloudBrowserEnabled } = request;
    const draft = get(talkDraft$);
    const resolvedModelSelection = await set(
      resolveCurrentNewThreadModelSelection$,
      signal,
    );
    if (!resolvedModelSelection) {
      return null;
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
    const features = get(featureSwitch$);
    const userMessage = userMessageForNewThread(request, prepared);
    const threadId = crypto.randomUUID();
    const clientEventId = crypto.randomUUID();
    const chatThreadEventId = crypto.randomUUID();
    set(
      appendOptimisticChatMessage$,
      createOptimisticChatMessageEntry(
        createNewThreadOptimisticMessageEntry({
          threadId,
          clientEventId,
          prepared,
          generationTemplate,
          userMessage,
        }),
      ),
    );
    await set(
      mintOptimisticThreadWithEvent$,
      {
        threadId,
        eventId: chatThreadEventId,
        agentId,
        selectedModel: resolvedModelSelection.selectedModel,
        serviceTier:
          resolvedModelSelection.codexServiceTier === "fast"
            ? "priority"
            : null,
        computerUseHostId: computerUseHostId ?? null,
        cloudBrowserEnabled: cloudBrowserEnabled ?? false,
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
    const sendBody = newThreadSendBody({
      agentId,
      threadId,
      clientEventId,
      prepared,
      modelSelection: resolvedModelSelection,
      codexFastModeEnabled: codexFastModeSwitchEnabled(features),
      realAgentInPreviewEnabled:
        features[FeatureSwitchKey.RealAgentInPreview] ?? false,
      generationTemplate,
      userMessage,
      computerUseHostId,
      cloudBrowserEnabled,
    });
    const sendResult = (async (): Promise<SendNewThreadMessageResult> => {
      await Promise.all([clearDraftResult, createResult]);
      signal.throwIfAborted();

      const result = await sendChatEvent(createClient, sendBody, signal);
      signal.throwIfAborted();
      L.debug("sendNewThreadMessage$ POST chat/events 201", {
        threadId: result.threadId,
        runId: result.runId,
      });
      return { threadId: result.threadId, runId: result.runId };
    })();
    return { threadId, sendResult };
  },
);

export const sendNewThread$ = command(
  async (
    { set },
    request: SendNewThreadMessageRequest,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const result = await set(sendNewThreadMessage$, request, signal);
    if (!result) {
      return false;
    }

    set(startChatNavigationTiming$);
    await set(
      routeChatThread$,
      {
        pane: "main",
        threadId: result.threadId,
        ...(request.routeSearchParams
          ? { searchParams: request.routeSearchParams }
          : {}),
      },
      signal,
    );
    await result.sendResult;
    signal.throwIfAborted();
    return true;
  },
);
