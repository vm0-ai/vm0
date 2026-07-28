import {
  useGet,
  useSet,
  useLoadable,
  useLastResolved,
  useLastLoadable,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { user$ } from "../../signals/auth.ts";
import { IconArrowUpRight, IconPin, IconUserPlus } from "@tabler/icons-react";
import { isSupportedRunModel } from "@vm0/api-contracts/contracts/model-providers";
import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import type { PublicConnectorCatalogStatusItem } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import {
  currentChatAgentId$,
  currentChatAgentDisplayName$,
} from "../../signals/agent-chat.ts";
import {
  setAgentPinned$,
  currentChatAgentPinned$,
} from "../../signals/zero-page/zero-pinned-agents.ts";

import { detach, Reason } from "../../signals/utils.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { openSettingsDialogAt$ } from "../../signals/zero-page/settings/settings-dialog.ts";
import { ZeroChatComposer } from "./zero-chat-composer.tsx";
import { ReplaceComposerDraftDialog } from "./replace-composer-draft-dialog.tsx";
import { CREATE_WORKFLOW_WITH_CHAT_PROMPT } from "./workflow-chat-prompts.ts";
import { connectorCatalogStatusByRef$ } from "../../signals/external/connectors.ts";
import {
  replaceWorkflowPromptDraftTarget$,
  setReplaceWorkflowPromptDraftTarget$,
} from "../../signals/chat-page/workflow-prompt-action.ts";
import { AttachmentLightbox } from "./zero-attachment-chips.tsx";
import {
  chatPageComposerConnectors,
  chatPageWorkflowComposer$,
  chatPageModelSelection$,
  chatPageSelectedModelOauthAvailable$,
  configureChatPageSelectedModel$,
  setChatPageInput$,
  setChatPageModelSelection$,
  updateCodexFastModeDefaultForSelection$,
  resetChatPageModelSelection$,
  chatPageTaglineIndex$,
  suggestedPrompts$,
  unfilteredSuggestedPrompts$,
} from "../../signals/zero-page/zero-chat-page.ts";
import { talkDraft$ } from "../../signals/zero-page/chat-draft.ts";
import {
  newThreadGenerationTemplate$,
  newThreadComputerAccess$,
  type NewThreadComputerAccess,
  resetNewThreadComputerAccess$,
  setNewThreadGenerationTemplate$,
  setNewThreadCloudBrowserEnabled$,
  setNewThreadComputerUseHostId$,
} from "../../signals/zero-page/zero-chat-composer.ts";
import {
  computerUseHosts$,
  selectedComputerUseHostId as resolveSelectedComputerUseHostId,
  subscribeComputerUseHostsChangedRef$,
  visibleComputerUseHosts,
  ZERO_DESKTOP_DOWNLOAD_URL,
} from "../../signals/zero-page/computer-use-hosts.ts";
import { lightboxUrl$ as attachmentLightboxUrl$ } from "../../signals/zero-page/zero-attachment-chips.ts";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { AgentAvatarImg } from "./zero-sidebar-shared.tsx";
import { Link } from "../router/link.tsx";
import { sendNewThread$ } from "../../signals/chat-page/optimistic-chat-thread-page.ts";
import {
  typewriterDisplayed$,
  typewriterRef$,
} from "../../signals/view-component-state.ts";
import { updateUserModelPreference$ } from "../../signals/external/user-model-preference.ts";
import { PersonalClaudeCodeDeviceAuthDialog } from "./components/settings/claude-code-device-auth-dialog.tsx";
import { PersonalCodexDeviceAuthDialog } from "./components/settings/codex-device-auth-dialog.tsx";
import { queueCurrentAgentDraftSync$ } from "../../signals/zero-page/agent-draft.ts";
import type { EditorDocumentSnapshot } from "../../signals/zero-page/user-message-document-codec.ts";
import { zeroBrowserEnabled$ } from "../../signals/external/feature-switch.ts";

function getTagline(
  agentName: string,
  userName: string | null,
  index: number,
): string {
  const taglines = userName
    ? [
        `Welcome back, ${userName}.`,
        `${userName}, what's the move?`,
        `Good to see you, ${userName}.`,
        `What's on your mind, ${userName}?`,
        `${userName} + ${agentName}. Let's roll.`,
        `Another day, another win, ${userName}.`,
        `Hey ${userName}, ready to build?`,
        `${userName} has entered the chat.`,
        `Good to see you, ${userName}.`,
        `${userName}! I saved your seat.`,
        `${userName}, let's make today count.`,
        `Coffee's ready, ${userName}. Let's go.`,
        `${userName}, I had a feeling you'd come.`,
        `What's cooking, ${userName}?`,
        `${userName}. New day, new ideas.`,
        `Ah, ${userName}. Right on time.`,
        `${userName}, what are we working on?`,
        `The usual, ${userName}?`,
      ]
    : [
        `Welcome back.`,
        `What's the move?`,
        `Good to see you.`,
        `What's on your mind?`,
        `Ready to roll.`,
        `Let's build something.`,
        `What are we working on?`,
      ];
  return taglines[index % taglines.length];
}

function TypewriterText({
  text,
  speed = 40,
}: {
  text: string;
  speed?: number;
}) {
  const displayed = useGet(typewriterDisplayed$);
  const typewriterRef = useSet(typewriterRef$);
  const typewriterKey = `${text}:${String(speed)}`;
  const displayedText = displayed[typewriterKey] ?? "";

  return (
    <>
      <span
        key={typewriterKey}
        ref={typewriterRef}
        className="contents"
        data-typewriter-speed={String(speed)}
        data-typewriter-key={typewriterKey}
        data-typewriter-text={text}
      >
        {displayedText}
      </span>
      {displayedText.length < text.length && (
        <span className="inline-block w-[2px] h-[1em] bg-foreground/60 ml-0.5 align-middle animate-pulse" />
      )}
    </>
  );
}

function InviteButton({ pageSignal }: { pageSignal: AbortSignal }) {
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const openSettings = useSet(openSettingsDialogAt$);
  const handleInvite = () => {
    detach(openSettings("people", pageSignal), Reason.DomCallback);
  };
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleInvite}
      className={`zero-btn-morandi gap-1.5${isAdmin ? "" : " invisible"}`}
      aria-hidden={isAdmin ? undefined : "true"}
      tabIndex={isAdmin ? undefined : -1}
      data-testid="invite-button"
    >
      <IconUserPlus size={14} stroke={1.5} />
      Invite people
    </Button>
  );
}

function PinPill() {
  const currentChatAgentId = useLastResolved(currentChatAgentId$);
  const pinnedStatus = useLastResolved(currentChatAgentPinned$);
  const [pinLoadable, saveAgentPinned] = useLoadableSet(setAgentPinned$);
  const pinSaving = pinLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);
  if (pinnedStatus !== false || !currentChatAgentId) {
    return null;
  }
  const handlePin = () => {
    detach(
      saveAgentPinned(
        { agentId: currentChatAgentId, pinned: true },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handlePin}
            disabled={pinSaving}
            className="absolute -top-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full zero-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground hover:shadow-md cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Pin to sidebar"
          >
            <IconPin size={12} stroke={2} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">Pin to sidebar</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ChatAgentAvatar({ agentId }: { agentId: string | null | undefined }) {
  return (
    <div className="relative shrink-0">
      {agentId ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                pathname="/agents/:agentId"
                options={{
                  pathParams: { agentId },
                }}
                aria-label="View agent profile"
                className="h-14 w-14 shrink-0 sm:h-16 sm:w-16 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-accent cursor-pointer"
              >
                <AgentAvatarImg
                  name={agentId}
                  alt=""
                  className="h-14 w-14 rounded-full object-cover object-top sm:h-16 sm:w-16"
                />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">View agent profile</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <div className="h-14 w-14 shrink-0 sm:h-16 sm:w-16 flex items-center justify-center overflow-hidden rounded-xl">
          <AgentAvatarImg
            name=""
            alt=""
            className="h-14 w-14 rounded-full object-cover object-top sm:h-16 sm:w-16"
          />
        </div>
      )}
      <PinPill />
    </div>
  );
}

interface SuggestedPrompt {
  title: string;
  description: string;
  prompt: string;
  connectors?: readonly string[];
}

function SuggestedPromptButton({
  item,
  connectorStatusByRef,
  onSelectPrompt,
}: {
  item: SuggestedPrompt;
  connectorStatusByRef:
    | ReadonlyMap<string, PublicConnectorCatalogStatusItem>
    | undefined;
  onSelectPrompt: (prompt: string) => void;
}) {
  const connectors =
    item.connectors?.flatMap((connectorRef) => {
      const connector = connectorStatusByRef?.get(connectorRef);
      return connector ? [{ connectorRef, icon: connector.icon }] : [];
    }) ?? [];
  return (
    <button
      type="button"
      className="zero-card cursor-pointer p-4 text-left flex flex-col relative group hover:bg-muted/30 transition-colors"
      onClick={() => {
        onSelectPrompt(item.prompt);
      }}
    >
      <IconArrowUpRight
        size={14}
        stroke={2}
        className="absolute top-4 right-4 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors"
      />
      <p className="text-sm font-semibold text-foreground pr-5">{item.title}</p>
      <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
        {item.description}
      </p>
      {connectors.length > 0 && (
        <div className="flex items-center gap-1.5 mt-auto pt-2.5">
          {connectors.map((connector) => {
            return (
              <span
                key={connector.connectorRef}
                className="flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background"
              >
                <ConnectorIcon icon={connector.icon} size={14} />
              </span>
            );
          })}
        </div>
      )}
    </button>
  );
}

function IdeasUseCasesButton() {
  const currentChatAgentId = useLastResolved(currentChatAgentId$);
  const navigate = useSet(detachedNavigateTo$);

  const handleClick = () => {
    if (!currentChatAgentId) {
      return;
    }
    navigate("/agents/:agentId/ideas", {
      pathParams: { agentId: currentChatAgentId },
    });
  };

  return (
    <button
      type="button"
      className="zero-card cursor-pointer p-4 text-left flex flex-col relative group hover:bg-muted/30 transition-colors"
      onClick={handleClick}
    >
      <IconArrowUpRight
        size={14}
        stroke={2}
        className="absolute top-4 right-4 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors"
      />
      <p className="text-sm font-semibold text-foreground pr-5">
        Ideas &amp; use cases
      </p>
      <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
        Browse use cases across all connectors
      </p>
      <div className="flex items-center gap-1.5 mt-auto pt-2.5 text-sm font-medium text-primary">
        <span>View all</span>
        <IconArrowUpRight size={14} stroke={2} />
      </div>
    </button>
  );
}

function SuggestedPromptsGrid({
  onSelectPrompt,
}: {
  onSelectPrompt: (prompt: string) => void;
}) {
  const connectorStatusByRef = useLastResolved(connectorCatalogStatusByRef$);
  const unfilteredSuggestedPrompts =
    useLastResolved(unfilteredSuggestedPrompts$) ?? [];
  const suggestedPromptsLoadable = useLoadable(suggestedPrompts$);
  const lastSuggestedPrompts = useLastResolved(suggestedPrompts$);
  const suggestedPrompts =
    suggestedPromptsLoadable.state === "hasData"
      ? suggestedPromptsLoadable.data
      : suggestedPromptsLoadable.state === "loading"
        ? (lastSuggestedPrompts ?? unfilteredSuggestedPrompts)
        : [];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 w-full">
      {suggestedPrompts.map((item) => {
        return (
          <SuggestedPromptButton
            key={item.title}
            item={item}
            connectorStatusByRef={connectorStatusByRef}
            onSelectPrompt={onSelectPrompt}
          />
        );
      })}
      <IdeasUseCasesButton />
    </div>
  );
}

function useAgentChatComposerModel(pageSignal: AbortSignal) {
  const modelSelectionLoadable = useLastLoadable(chatPageModelSelection$);
  const modelSelection =
    modelSelectionLoadable.state === "hasData"
      ? modelSelectionLoadable.data
      : null;
  const setModelSelection = useSet(setChatPageModelSelection$);
  const updateUserModelPreference = useSet(updateUserModelPreference$);
  const updateCodexFastModeDefault = useSet(
    updateCodexFastModeDefaultForSelection$,
  );
  const selectedModelOauthAvailable =
    useLastResolved(chatPageSelectedModelOauthAvailable$) ?? true;
  const configureSelectedModel = useSet(configureChatPageSelectedModel$);

  const handleModelSelectionChange = (
    selection: typeof modelSelection,
  ): void => {
    setModelSelection(selection);
    const selectedModel = selection?.selectedModel;
    if (isSupportedRunModel(selectedModel)) {
      detach(
        updateUserModelPreference({ selectedModel }, pageSignal),
        Reason.DomCallback,
      );
    }
    detach(
      updateCodexFastModeDefault(selection, pageSignal),
      Reason.DomCallback,
    );
  };

  const modelPicker = {
    value: modelSelection,
    onChange: handleModelSelectionChange,
  };
  const submitBlockerProps =
    modelSelection && !selectedModelOauthAvailable
      ? {
          message:
            "The selected model is not available. Configure it before sending.",
          actionLabel: "Model Configure",
          onAction: () => {
            detach(configureSelectedModel(pageSignal), Reason.DomCallback);
          },
        }
      : undefined;
  const modelPickerLoading = modelSelectionLoadable.state === "loading";

  return {
    modelPicker,
    modelPickerLoading,
    submitBlockerProps,
  };
}

function useNewThreadComputerUse() {
  const computerUseHostsLoadable = useLastLoadable(computerUseHosts$);
  const lastResolvedComputerUseHosts = useLastResolved(computerUseHosts$) ?? [];
  const computerUseHosts =
    computerUseHostsLoadable.state === "hasData"
      ? computerUseHostsLoadable.data
      : lastResolvedComputerUseHosts;
  const storedComputerAccess = useGet(newThreadComputerAccess$);
  const cloudBrowserAvailable = useGet(zeroBrowserEnabled$);
  // Cloud browser is the default surface for a new thread wherever Zero Browser
  // is available; the user can still pick a computer or none for this draft.
  const computerAccess: NewThreadComputerAccess =
    storedComputerAccess ??
    (cloudBrowserAvailable ? { kind: "cloudBrowser" } : { kind: "none" });
  const cloudBrowserEnabled =
    cloudBrowserAvailable && computerAccess.kind === "cloudBrowser";
  const selectedComputerUseHostId = resolveSelectedComputerUseHostId(
    computerUseHosts,
    computerAccess.kind === "computerUse" ? computerAccess.hostId : null,
  );
  const visibleHosts = visibleComputerUseHosts(
    computerUseHosts,
    selectedComputerUseHostId,
  );
  const setComputerUseHostId = useSet(setNewThreadComputerUseHostId$);
  const setCloudBrowserEnabled = useSet(setNewThreadCloudBrowserEnabled$);
  const resetComputerAccess = useSet(resetNewThreadComputerAccess$);

  return {
    selectedComputerUseHostId,
    cloudBrowserEnabled,
    clearComputerAccess: resetComputerAccess,
    computerUse: {
      hosts: visibleHosts,
      loading:
        computerUseHostsLoadable.state === "loading" &&
        computerUseHosts.length === 0,
      selectedHostId: selectedComputerUseHostId,
      onChange: setComputerUseHostId,
      cloudBrowserAvailable,
      cloudBrowserEnabled,
      onCloudBrowserChange: setCloudBrowserEnabled,
      downloadUrl: ZERO_DESKTOP_DOWNLOAD_URL,
    },
  };
}

function useAgentChatDraftSync(pageSignal: AbortSignal) {
  const queueDraftSync = useSet(queueCurrentAgentDraftSync$);

  return () => {
    detach(queueDraftSync(pageSignal), Reason.DomCallback);
  };
}

function useAgentChatSendMessage({
  currentChatAgentId,
  selectedComputerUseHostId,
  cloudBrowserEnabled,
  clearComputerAccess,
  setGenerationTemplate,
  resetModelSelection,
}: {
  currentChatAgentId: string | null | undefined;
  selectedComputerUseHostId: string | null | undefined;
  cloudBrowserEnabled: boolean;
  clearComputerAccess: () => void;
  setGenerationTemplate: (value: GenerationTemplateRequest | undefined) => void;
  resetModelSelection: () => void;
}): {
  onSend: (
    message: string,
    selectedGenerationTemplate: GenerationTemplateRequest | undefined,
    editorDocument: EditorDocumentSnapshot,
  ) => void;
  submissionLoading: boolean;
} {
  const [sendLoadable, sendNewThread] = useLoadableSet(sendNewThread$);
  const rootSignal = useGet(rootSignal$);

  return {
    onSend: (message, selectedGenerationTemplate, editorDocument) => {
      if (!currentChatAgentId) {
        return;
      }

      detach(
        (async () => {
          const sent = await sendNewThread(
            {
              agentId: currentChatAgentId,
              prompt: message,
              generationTemplate: selectedGenerationTemplate,
              editorDocument,
              ...(selectedComputerUseHostId
                ? { computerUseHostId: selectedComputerUseHostId }
                : {}),
              ...(cloudBrowserEnabled ? { cloudBrowserEnabled: true } : {}),
            },
            rootSignal,
          );
          if (sent) {
            setGenerationTemplate(undefined);
            clearComputerAccess();
            resetModelSelection();
          }
        })(),
        Reason.DomCallback,
      );
    },
    submissionLoading: sendLoadable.state === "loading",
  };
}

function useAgentChatComposerWorkflowPrompt({
  readInput,
  setInput,
  queueDraftSync,
}: {
  readInput: () => string;
  setInput: (value: string) => void;
  queueDraftSync: () => void;
}): {
  onCreateWorkflowPrompt: (() => void) | undefined;
  replaceDraftDialogOpen: boolean;
  onConfirmReplaceDraft: () => void;
  onReplaceDialogOpenChange: (open: boolean) => void;
} {
  const replaceDraftTarget = useGet(replaceWorkflowPromptDraftTarget$);
  const setReplaceDraftTarget = useSet(setReplaceWorkflowPromptDraftTarget$);
  const workflowPromptDraftTarget = "composer:new-thread";
  const replaceDraftDialogOpen =
    replaceDraftTarget === workflowPromptDraftTarget;

  const applyWorkflowPrompt = () => {
    setInput(CREATE_WORKFLOW_WITH_CHAT_PROMPT);
    queueDraftSync();
  };

  const handleCreateWorkflowPrompt = () => {
    if (readInput().trim().length > 0) {
      setReplaceDraftTarget(workflowPromptDraftTarget);
      return;
    }
    applyWorkflowPrompt();
  };

  const handleConfirmReplaceDraft = () => {
    setReplaceDraftTarget(null);
    applyWorkflowPrompt();
  };

  const handleReplaceDialogOpenChange = (open: boolean) => {
    setReplaceDraftTarget(open ? workflowPromptDraftTarget : null);
  };

  return {
    onCreateWorkflowPrompt: handleCreateWorkflowPrompt,
    replaceDraftDialogOpen,
    onConfirmReplaceDraft: handleConfirmReplaceDraft,
    onReplaceDialogOpenChange: handleReplaceDialogOpenChange,
  };
}

export function AgentChatPage() {
  const currentChatAgentId = useLastResolved(currentChatAgentId$);
  const currentChatAgentDisplayName = useLastResolved(
    currentChatAgentDisplayName$,
  );

  const generationTemplate = useGet(newThreadGenerationTemplate$);
  const setGenerationTemplate = useSet(setNewThreadGenerationTemplate$);
  const {
    selectedComputerUseHostId,
    cloudBrowserEnabled,
    clearComputerAccess,
    computerUse,
  } = useNewThreadComputerUse();
  const pageSignal = useGet(pageSignal$);
  const subscribeComputerUseHostsChangedRef = useSet(
    subscribeComputerUseHostsChangedRef$,
  );
  const { modelPicker, modelPickerLoading, submitBlockerProps } =
    useAgentChatComposerModel(pageSignal);
  const resetModelSelection = useSet(resetChatPageModelSelection$);
  const { onSend: handleSendMessage, submissionLoading } =
    useAgentChatSendMessage({
      currentChatAgentId,
      selectedComputerUseHostId,
      cloudBrowserEnabled,
      clearComputerAccess,
      setGenerationTemplate,
      resetModelSelection,
    });

  const userFirstName = useLastResolved(user$)?.firstName ?? null;

  const draft = useGet(talkDraft$);
  const composer = useGet(chatPageWorkflowComposer$);
  const readInput = useSet(draft.readInput$);
  const setInput = useSet(setChatPageInput$);
  const queueAgentDraftSync = useAgentChatDraftSync(pageSignal);
  const workflowPrompt = useAgentChatComposerWorkflowPrompt({
    readInput,
    setInput,
    queueDraftSync: queueAgentDraftSync,
  });
  const taglineIndex = useGet(chatPageTaglineIndex$);
  const tagline =
    currentChatAgentDisplayName !== undefined
      ? getTagline(
          currentChatAgentDisplayName ?? "Zero",
          userFirstName,
          taglineIndex,
        )
      : "";

  const lightboxUrl = useGet(attachmentLightboxUrl$);

  const handleInputChange = (value: string) => {
    setInput(value);
    queueAgentDraftSync();
  };

  const handleDraftChange = () => {
    queueAgentDraftSync();
  };

  return (
    <div className="relative flex flex-1 flex-col min-h-0">
      <span ref={subscribeComputerUseHostsChangedRef} hidden />
      <header className="hidden md:block shrink-0 bg-transparent px-4 sm:px-6 pt-4 pb-2">
        <div className="flex justify-end items-center gap-2">
          <InviteButton pageSignal={pageSignal} />
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6">
        <div className="mx-auto w-full max-w-[900px] flex flex-col items-stretch gap-6 pt-8 pb-12 sm:pt-[20vh] sm:pb-[10vh]">
          <div className="flex items-center gap-4 w-full">
            <ChatAgentAvatar agentId={currentChatAgentId} />
            <div className="flex-1 min-w-0 flex items-center gap-3">
              <h2
                aria-label={tagline}
                data-testid="chat-tagline"
                className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground"
              >
                <TypewriterText text={tagline} />
              </h2>
            </div>
          </div>

          <ZeroChatComposer
            className="w-full"
            composer={composer}
            composerConnectors={chatPageComposerConnectors}
            draft={draft}
            onSend={handleSendMessage}
            onDraftChange={handleDraftChange}
            submissionLoading={submissionLoading}
            displayName={currentChatAgentDisplayName ?? ""}
            autoFocus
            modelPicker={modelPicker}
            templatePicker={{
              value: generationTemplate,
              onChange: setGenerationTemplate,
            }}
            onCreateWorkflowPrompt={workflowPrompt.onCreateWorkflowPrompt}
            computerUse={computerUse}
            modelPickerLoading={modelPickerLoading}
            submitBlocker={submitBlockerProps}
          />
          <ReplaceComposerDraftDialog
            open={workflowPrompt.replaceDraftDialogOpen}
            onOpenChange={workflowPrompt.onReplaceDialogOpenChange}
            onConfirm={workflowPrompt.onConfirmReplaceDraft}
          />

          <SuggestedPromptsGrid onSelectPrompt={handleInputChange} />
        </div>
      </main>
      <PersonalClaudeCodeDeviceAuthDialog />
      <PersonalCodexDeviceAuthDialog />
      {lightboxUrl && <AttachmentLightbox />}
    </div>
  );
}
