import { command, computed, state } from "ccstate";
import { isSupportedRunModel } from "@vm0/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import { currentAgentId$ } from "../agent.ts";
import { sendNewThread$ } from "../chat-page/optimistic-chat-thread-page.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { updateUserModelPreference$ } from "../external/user-model-preference.ts";
import {
  createAgentDraftSignals,
  type EnsuredAgentDraft,
} from "./agent-draft.ts";
import {
  computerUseHosts$,
  selectedComputerUseHostId,
} from "./computer-use-hosts.ts";
import {
  createComposerSignals,
  type ComposerSubmission,
} from "./composer-signals.ts";
import type { ChatEvent } from "../chat-page/chat-event-types.ts";
import {
  chatPageModelSelection$,
  chatPageSelectedModelOauthAvailable$,
  configureChatPageSelectedModel$,
  resetChatPageModelSelection$,
  setChatPageModelSelection$,
} from "./zero-chat-page.ts";
import {
  newThreadComputerAccess$,
  resetNewThreadComputerAccess$,
  setNewThreadCloudBrowserEnabled$,
  setNewThreadComputerUseHostId$,
} from "./zero-chat-composer.ts";

const idle$ = computed((): Promise<boolean> => {
  return Promise.resolve(false);
});
const chatEvents$ = computed((): ChatEvent[] => {
  return [];
});

const setModelSelection$ = command(
  async (
    { get, set },
    selection: ModelProviderSelection | null,
    signal: AbortSignal,
  ): Promise<void> => {
    set(setChatPageModelSelection$, selection);
    const selectedModel = selection?.selectedModel;
    const explicitDefaultActionEnabled =
      get(featureSwitch$)[FeatureSwitchKey.NewChatDefaultModelAction] ?? false;
    if (!explicitDefaultActionEnabled && isSupportedRunModel(selectedModel)) {
      await set(
        updateUserModelPreference$,
        {
          selectedModel,
          serviceTier:
            selection?.codexServiceTier === "fast" ? "priority" : null,
        },
        signal,
      );
    }
  },
);

const computerUseHostId$ = computed((get): string | null => {
  const selection = get(newThreadComputerAccess$);
  return selection.kind === "computerUse" ? selection.hostId : null;
});
const cloudBrowserEnabled$ = computed((get): boolean => {
  return get(newThreadComputerAccess$).kind === "cloudBrowser";
});
const setComputerUseHostId$ = command(
  ({ set }, hostId: string | null, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    set(setNewThreadComputerUseHostId$, hostId);
    return Promise.resolve();
  },
);
const setCloudBrowserEnabled$ = command(
  ({ set }, enabled: boolean, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    set(setNewThreadCloudBrowserEnabled$, enabled);
    return Promise.resolve();
  },
);

const noOpAction$ = command((_context, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted();
  return Promise.resolve();
});
const noOpEventAction$ = command(
  (_context, _eventId: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    return Promise.resolve();
  },
);
const noOp$ = command((): void => {});

function createAgentComposerSignalsWithDraft(
  agentId: string,
  agentDraft: EnsuredAgentDraft,
) {
  const submitMessage$ = command(
    async (
      { get, set },
      action: "send" | "queue",
      submission: ComposerSubmission,
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (action !== "send") {
        return false;
      }
      const access = get(newThreadComputerAccess$);
      const hosts = await get(computerUseHosts$);
      signal.throwIfAborted();
      const hostId =
        access.kind === "computerUse"
          ? selectedComputerUseHostId(hosts, access.hostId)
          : null;
      const sent = await set(
        sendNewThread$,
        {
          agentId,
          draft: agentDraft.draft,
          prompt: submission.prompt,
          generationTemplate: submission.generationTemplate,
          editorDocument: submission.editorDocument,
          ...(access.kind === "computerUse"
            ? { computerUseHostId: hostId }
            : {}),
          ...(access.kind === "cloudBrowser"
            ? { cloudBrowserEnabled: true }
            : {}),
        },
        signal,
      );
      if (sent) {
        set(resetNewThreadComputerAccess$);
        set(resetChatPageModelSelection$);
      }
      return sent;
    },
  );

  return createComposerSignals({
    agentId,
    draft: {
      signals: agentDraft.draft,
      save$: agentDraft.queueDraftSync$,
    },
    chatEvents$,
    singleLineOnMobile: false,
    modelSelection$: chatPageModelSelection$,
    selectedModelOauthAvailable$: chatPageSelectedModelOauthAvailable$,
    setModelSelection$,
    configureSelectedModel$: configureChatPageSelectedModel$,
    computerUseHostId$,
    cloudBrowserEnabled$,
    setComputerUseHostId$,
    setCloudBrowserEnabled$,
    submitMessage$,
    cancelRun$: noOpAction$,
    cancellationRecoveryPending$: idle$,
    removeQueuedMessage$: noOpEventAction$,
    removeAutomationEvent$: noOpEventAction$,
    cancelActiveGoal$: noOpAction$,
    openActiveGoal$: noOp$,
  });
}

/**
 * Creates the public composer signals for an agent chat.
 *
 * @public
 */
export function createAgentComposerSignals(agentId: string) {
  return createAgentComposerSignalsWithDraft(
    agentId,
    createAgentDraftSignals(agentId),
  );
}

interface AgentComposerContext {
  readonly agentId: string;
  readonly agentDraft: EnsuredAgentDraft;
}

const internalAgentComposerContext$ = state<AgentComposerContext | null>(null);

export const setAgentComposerContext$ = command(
  ({ set }, context: AgentComposerContext): void => {
    set(internalAgentComposerContext$, context);
  },
);

export const agentChatComposerSignals$ = computed((get) => {
  // Recreate the editor when delayed feature-switch bootstrap changes its semantics.
  get(featureSwitch$);
  const agentId = get(currentAgentId$);
  if (!agentId) {
    throw new Error("Chat composer requires an active agent");
  }
  const context = get(internalAgentComposerContext$);
  return context?.agentId === agentId
    ? createAgentComposerSignalsWithDraft(agentId, context.agentDraft)
    : createAgentComposerSignals(agentId);
});
