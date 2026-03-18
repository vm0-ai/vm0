import type { ChangeEvent } from "react";
import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  IconSend,
  IconPaperclip,
  IconLoader2,
  IconPlayerStop,
  IconPlug,
  IconPlus,
} from "@tabler/icons-react";
import {
  Button,
  Card,
  CardContent,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@vm0/ui";
import { detach, Reason, throwIfAbort } from "../../signals/utils.ts";
import {
  zeroChatAttachments$,
  uploadZeroAttachment$,
  removeZeroAttachment$,
} from "../../signals/zero-page/zero-chat.ts";
import { AttachmentChips } from "./zero-attachment-chips.tsx";
import { useFileUploadHandlers } from "./use-file-upload-handlers.ts";
import { useModelSelection } from "./zero-model-preference.ts";
import { useSendKeyHandler } from "./zero-send-key.ts";
import type { ConnectorType } from "@vm0/core";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  AddConnectionDialog,
  ConnectModal,
} from "./components/settings/add-connection-dialog.tsx";
import { skills$ } from "../../data/skills.ts";
import {
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
} from "../../signals/zero-page/zero-onboarding.ts";
import {
  allConnectorTypes$,
  connectConnector$,
  selectedConnectorType$,
  setSelectedConnectorType$,
  justConnectedTypes$,
  clearJustConnectedTypes$,
} from "../../signals/zero-page/settings/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  zeroAddedSkills$,
  addZeroSkill$,
  saveZeroSkills$,
} from "../../signals/zero-page/zero-skills.ts";
import { toast } from "@vm0/ui/components/ui/sonner";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ZeroChatComposerProps {
  input: string;
  onInputChange: (value: string) => void;
  onSend: (message: string, options?: { modelProvider: string }) => void;
  sending?: boolean;
  /** Cancel the active run. When provided, a stop button replaces the send button while sending. */
  onCancel?: () => void;
  agentName: string;
  /** Navigate to connectors management page. */
  onManageConnectors?: () => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildModelOpts(model: string): { modelProvider: string } | undefined {
  return model !== "default" ? { modelProvider: model } : undefined;
}

interface ComposerConnectorItem {
  type: string;
  label: string;
  iconUrl?: string;
  connected: boolean;
}

function buildConnectorItem(
  name: string,
  skillMap: Map<string, { label: string; icon?: string }>,
  connectorMap: Map<ConnectorType, { label: string; connected: boolean }>,
  optimistic: Set<string>,
): ComposerConnectorItem {
  const skill = skillMap.get(name);
  const connector = connectorMap.get(name as ConnectorType);
  return {
    type: name,
    label: skill?.label ?? connector?.label ?? name,
    iconUrl: skill?.icon,
    connected: optimistic.has(name) ? true : (connector?.connected ?? false),
  };
}

function maybeClearOptimistic(
  optimistic: Set<string>,
  connectorMap: Map<ConnectorType, { connected: boolean }>,
  clear: () => void,
) {
  if (optimistic.size === 0) {
    return;
  }
  const allConfirmed = [...optimistic].every(
    (t) => connectorMap.get(t as ConnectorType)?.connected,
  );
  if (allConfirmed) {
    clear();
  }
}

function resolveConnectorLabel(
  type: string,
  skillMap: Map<string, { label: string }>,
  connectorMap: Map<ConnectorType, { label: string }>,
): string {
  return (
    skillMap.get(type)?.label ??
    connectorMap.get(type as ConnectorType)?.label ??
    type
  );
}

function startConnectorFlow(
  type: string,
  connectorMap: Map<ConnectorType, { availableAuthMethods: string[] }>,
  setSelectedType: (t: ConnectorType | null) => void,
  connect: (t: ConnectorType, signal: AbortSignal) => Promise<boolean>,
  signal: AbortSignal,
) {
  const ct = connectorMap.get(type as ConnectorType);
  if (!ct) {
    return;
  }
  if (
    ct.availableAuthMethods.length === 1 &&
    ct.availableAuthMethods[0] === "api-token"
  ) {
    setSelectedType(type as ConnectorType);
  } else {
    detach(connect(type as ConnectorType, signal), Reason.DomCallback);
  }
}

// ---------------------------------------------------------------------------
// Connector sub-components
// ---------------------------------------------------------------------------

function ConnectorTriggerIcons({
  connectors,
}: {
  connectors: ComposerConnectorItem[];
}) {
  const connected = connectors.filter((c) => c.connected).slice(0, 3);
  if (connected.length === 0) {
    return <IconPlug size={18} stroke={1.5} />;
  }
  return (
    <span className="flex items-center -space-x-1.5">
      {connected.map((c) => (
        <span
          key={c.type}
          className="flex h-7 w-7 items-center justify-center rounded-full bg-background"
          style={{ border: "0.7px solid hsl(var(--gray-400))" }}
        >
          {c.iconUrl ? (
            <img src={c.iconUrl} alt="" className="h-4 w-4" />
          ) : (
            <ConnectorIcon type={c.type as ConnectorType} size={16} />
          )}
        </span>
      ))}
    </span>
  );
}

function ConnectorsPopoverButton({
  connectors,
  onOpenAddDialog,
  onConnect,
  onManageConnectors,
  agentName,
}: {
  connectors: ComposerConnectorItem[];
  onOpenAddDialog: () => void;
  onConnect: (type: string) => void;
  onManageConnectors?: () => void;
  agentName: string;
}) {
  return (
    <Popover>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex shrink-0 items-center justify-center rounded-lg h-9 min-w-9 px-1.5 hover:bg-accent transition-colors"
              >
                <ConnectorTriggerIcons connectors={connectors} />
              </button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent side="top" className="text-xs">
            Connectors
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent side="top" align="start" className="w-64 p-0 rounded-xl">
        {connectors.length > 0 && (
          <div className="p-2">
            <div className="flex flex-col">
              {connectors.map((item) => (
                <div
                  key={item.type}
                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center",
                      !item.connected && "opacity-40",
                    )}
                  >
                    {item.iconUrl ? (
                      <img src={item.iconUrl} alt="" className="h-5 w-5" />
                    ) : (
                      <ConnectorIcon
                        type={item.type as ConnectorType}
                        size={20}
                      />
                    )}
                  </span>
                  <span
                    className={cn(
                      "text-sm flex-1",
                      item.connected
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {item.label}
                  </span>
                  {item.connected ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                  ) : (
                    <button
                      type="button"
                      className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        onConnect(item.type);
                      }}
                    >
                      Connect
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        <div
          className={cn(
            "p-2 flex flex-col",
            connectors.length > 0 && "border-t border-border/50",
          )}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-accent transition-colors"
            onClick={() => onOpenAddDialog()}
          >
            <IconPlus
              size={20}
              stroke={1.5}
              className="shrink-0 text-muted-foreground"
            />
            Add connector
          </button>
          {onManageConnectors && (
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-accent transition-colors"
              onClick={onManageConnectors}
            >
              <IconPlug
                size={20}
                stroke={1.5}
                className="shrink-0 text-muted-foreground"
              />
              Manage connectors in {agentName}
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Main composer
// ---------------------------------------------------------------------------

export function ZeroChatComposer({
  input,
  onInputChange,
  onSend,
  sending,
  onCancel,
  agentName,
  onManageConnectors,
  className,
}: ZeroChatComposerProps) {
  // Attachments
  const attachments = useGet(zeroChatAttachments$);
  const uploadAttachment = useSet(uploadZeroAttachment$);
  const removeAttachment = useSet(removeZeroAttachment$);

  // File picker
  const fileInputEl$ = useCCState<HTMLInputElement | null>(null);
  const fileInputEl = useGet(fileInputEl$);
  const setFileInputEl = useSet(fileInputEl$);

  // File upload (paste / drag-drop)
  const { dragOver, handlePaste, handleDrop, handleDragOver, handleDragLeave } =
    useFileUploadHandlers();

  // Model selection
  const { modelOptions, selectedModel, setSelectedModel, persistSelection } =
    useModelSelection(agentName);

  // Connectors
  const allTypesLoadable = useLastLoadable(allConnectorTypes$);
  const addedSkillsLoadable = useLastLoadable(zeroAddedSkills$);
  const connectConnector = useSet(connectConnector$);
  const pageSignal = useGet(pageSignal$);
  const selectedConnType = useGet(selectedConnectorType$);
  const setSelectedConnType = useSet(setSelectedConnectorType$);
  const onboardingActive = useLastLoadable(zeroNeedsOnboarding$);
  const memberOnboardingActive = useLastLoadable(zeroNeedsMemberOnboarding$);
  const isOnboarding =
    (onboardingActive.state === "hasData" && onboardingActive.data) ||
    (memberOnboardingActive.state === "hasData" && memberOnboardingActive.data);
  const allSkills = useGet(skills$);
  const addSkill = useSet(addZeroSkill$);
  const saveSkills = useSet(saveZeroSkills$);
  const optimisticConnected = useGet(justConnectedTypes$);
  const clearOptimistic = useSet(clearJustConnectedTypes$);
  const addDialogOpen$ = useCCState(false);
  const addDialogOpen = useGet(addDialogOpen$);
  const setAddDialogOpen = useSet(addDialogOpen$);

  const allConnectors =
    allTypesLoadable.state === "hasData" ? allTypesLoadable.data : [];
  const connectorMap = new Map(allConnectors.map((c) => [c.type, c]));
  maybeClearOptimistic(optimisticConnected, connectorMap, clearOptimistic);
  const skillMap = new Map(allSkills.map((s) => [s.value, s]));
  const addedSkills =
    addedSkillsLoadable.state === "hasData" ? addedSkillsLoadable.data : [];
  const addedSet = new Set(addedSkills);

  const composerConnectors: ComposerConnectorItem[] = addedSkills
    .filter((name) => connectorMap.has(name as ConnectorType))
    .map((name) =>
      buildConnectorItem(name, skillMap, connectorMap, optimisticConnected),
    );

  const handleConnectSuccess = (type: string) => {
    const label = resolveConnectorLabel(type, skillMap, connectorMap);
    detach(
      (async () => {
        await addSkill(type);
        try {
          await saveSkills();
        } catch (error) {
          throwIfAbort(error);
          // May fail during onboarding when compose doesn't exist yet — ignore
        }
        toast.success(`${label} connected`);
      })(),
      Reason.DomCallback,
    );
  };

  const handleConnectConnector = (type: string) =>
    startConnectorFlow(
      type,
      connectorMap,
      setSelectedConnType,
      connectConnector,
      pageSignal,
    );

  // Send
  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || sending) {
      return;
    }
    persistSelection();
    onSend(trimmed, buildModelOpts(selectedModel));
  };

  const handleKeyDown = useSendKeyHandler(handleSend);

  const handleFileSelect = () => {
    fileInputEl?.click();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) {
      return;
    }
    for (const file of files) {
      detach(uploadAttachment(file), Reason.DomCallback);
    }
    e.target.value = "";
  };

  return (
    <>
      <input
        ref={setFileInputEl}
        type="file"
        className="hidden"
        accept="image/*,.pdf,.txt,.csv,.md,.json"
        multiple
        onChange={handleFileChange}
      />
      <Card
        className={cn(
          "zero-composer overflow-hidden",
          className,
          dragOver && "outline outline-2 outline-blue-400/60",
        )}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <CardContent className="p-0">
          <div className="flex flex-col">
            {attachments.length > 0 && (
              <AttachmentChips
                attachments={attachments}
                onRemove={removeAttachment}
              />
            )}
            <textarea
              className="w-full resize-none bg-transparent px-5 pt-4 pb-2 text-sm text-foreground placeholder:text-muted-foreground border-0 min-h-[88px] focus:outline-none focus:ring-0"
              rows={3}
              placeholder="Ask me to automate workflows, manage tasks..."
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              disabled={sending}
            />
            <div className="flex items-center justify-between gap-2 px-4 py-3">
              <div className="flex items-center gap-1 text-muted-foreground">
                <button
                  type="button"
                  className="p-[9px] rounded-lg hover:bg-accent hover:text-foreground transition-colors duration-200"
                  aria-label="Attach"
                  onClick={handleFileSelect}
                >
                  <IconPaperclip size={18} stroke={1.5} />
                </button>
                <ConnectorsPopoverButton
                  connectors={composerConnectors}
                  onOpenAddDialog={() => setAddDialogOpen(true)}
                  onConnect={handleConnectConnector}
                  onManageConnectors={onManageConnectors}
                  agentName={agentName}
                />
              </div>
              <div className="flex items-center gap-2">
                <Select value={selectedModel} onValueChange={setSelectedModel}>
                  <SelectTrigger className="h-9 min-w-[100px] gap-1 rounded-lg border-none bg-transparent text-sm text-foreground shadow-none hover:bg-accent transition-colors [&>svg]:h-5 [&>svg]:w-5 [&>svg]:opacity-80">
                    <SelectValue placeholder="Model" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.map((opt) => (
                      <SelectItem
                        key={opt.value}
                        value={opt.value}
                        className="text-sm"
                      >
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {sending && onCancel ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="rounded-lg h-9 w-9 p-0 shrink-0"
                    onClick={onCancel}
                    aria-label="Stop"
                  >
                    <IconPlayerStop size={16} />
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="rounded-lg h-9 w-9 p-0 shrink-0"
                    onClick={handleSend}
                    disabled={!input.trim() || sending}
                    aria-label="Send"
                  >
                    {sending ? (
                      <IconLoader2 size={16} className="animate-spin" />
                    ) : (
                      <IconSend size={16} stroke={2} />
                    )}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
      <AddConnectionDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        variant="zero"
        excludeTypes={addedSet}
        onConnectSuccess={handleConnectSuccess}
        onAdd={handleConnectSuccess}
      />
      {selectedConnType && !isOnboarding && (
        <ConnectModal
          onClose={() => setSelectedConnType(null)}
          onSuccess={() => {
            if (selectedConnType && !addedSet.has(selectedConnType)) {
              handleConnectSuccess(selectedConnType);
            }
          }}
        />
      )}
    </>
  );
}
