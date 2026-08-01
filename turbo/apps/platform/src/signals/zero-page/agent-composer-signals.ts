import { command, computed } from "ccstate";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isSupportedRunModel } from "@vm0/api-contracts/contracts/model-providers";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import { currentChatAgent$, currentChatAgentId$ } from "../agent-chat.ts";
import { sendNewThread$ } from "../chat-page/optimistic-chat-thread-page.ts";
import { updateUserModelPreference$ } from "../external/user-model-preference.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { queueCurrentAgentDraftSync$ } from "./agent-draft.ts";
import { talkDraft$ } from "./chat-draft.ts";
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
  updateCodexFastModeDefaultForSelection$,
} from "./zero-chat-page.ts";
import {
  newThreadComputerAccess$,
  newThreadGenerationTemplate$,
  resetNewThreadComputerAccess$,
  setNewThreadCloudBrowserEnabled$,
  setNewThreadComputerUseHostId$,
  setNewThreadGenerationTemplate$,
} from "./zero-chat-composer.ts";

const agent$ = computed(async (get) => {
  const agent = await get(currentChatAgent$);
  if (!agent) {
    throw new Error("Chat composer requires an active agent");
  }
  return agent;
});

const idle$ = computed((): Promise<boolean> => {
  return Promise.resolve(false);
});
const chatEvents$ = computed((): ChatEvent[] => {
  return [];
});

const draftChanged$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await set(queueCurrentAgentDraftSync$, signal);
  },
);

const setModelSelection$ = command(
  async (
    { set },
    selection: ModelProviderSelection | null,
    signal: AbortSignal,
  ): Promise<void> => {
    set(setChatPageModelSelection$, selection);
    const selectedModel = selection?.selectedModel;
    if (isSupportedRunModel(selectedModel)) {
      await set(updateUserModelPreference$, { selectedModel }, signal);
    }
    await set(updateCodexFastModeDefaultForSelection$, selection, signal);
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

const submitMessage$ = command(
  async (
    { get: read, set },
    action: "send" | "queue",
    submission: ComposerSubmission,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (action !== "send") {
      throw new Error("The new-thread composer does not support queueing");
    }
    const agentId = await read(currentChatAgentId$);
    signal.throwIfAborted();
    if (!agentId) {
      return false;
    }
    const access = read(newThreadComputerAccess$);
    const hosts = await read(computerUseHosts$);
    signal.throwIfAborted();
    const hostId =
      access.kind === "computerUse"
        ? selectedComputerUseHostId(hosts, access.hostId)
        : null;
    const sent = await set(
      sendNewThread$,
      {
        agentId,
        prompt: submission.prompt,
        generationTemplate: submission.generationTemplate,
        editorDocument: submission.editorDocument,
        ...(access.kind === "computerUse" ? { computerUseHostId: hostId } : {}),
        ...(access.kind === "cloudBrowser"
          ? { cloudBrowserEnabled: true }
          : {}),
      },
      signal,
    );
    if (sent) {
      set(setNewThreadGenerationTemplate$, undefined);
      set(resetNewThreadComputerAccess$);
      set(resetChatPageModelSelection$);
    }
    return sent;
  },
);

const unsupportedAction$ = command(
  (_context, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    return Promise.reject(
      new Error("This composer action is unavailable for a new thread"),
    );
  },
);
const unsupportedEventAction$ = command(
  (_context, _eventId: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    return Promise.reject(
      new Error("This composer event action is unavailable for a new thread"),
    );
  },
);
const openActiveGoal$ = command((): void => {
  throw new Error("Active goals are unavailable for a new thread");
});

export const agentChatComposerSignals$ = computed((get) => {
  const draft = get(talkDraft$);
  const features = get(featureSwitch$);

  return createComposerSignals({
    agent$,
    draft,
    chatEvents$,
    inlineTemplatesEnabled:
      features[FeatureSwitchKey.StructuredPromptInlineTemplates] ?? false,
    generationTemplate$: newThreadGenerationTemplate$,
    setGenerationTemplate$: setNewThreadGenerationTemplate$,
    singleLineOnMobile: false,
    draftChanged$,
    modelSelection$: chatPageModelSelection$,
    selectedModelOauthAvailable$: chatPageSelectedModelOauthAvailable$,
    setModelSelection$,
    configureSelectedModel$: configureChatPageSelectedModel$,
    computerUseHostId$,
    cloudBrowserEnabled$,
    setComputerUseHostId$,
    setCloudBrowserEnabled$,
    submitMessage$,
    cancelRun$: unsupportedAction$,
    cancellationRecoveryPending$: idle$,
    removeQueuedMessage$: unsupportedEventAction$,
    removeWorkflowEvent$: unsupportedEventAction$,
    cancelActiveGoal$: unsupportedAction$,
    openActiveGoal$,
  });
});
