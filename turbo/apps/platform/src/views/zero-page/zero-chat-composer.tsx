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
  if (ct.availableAuthMethods.includes("api-token")) {
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
  const hasDisconnected = connectors.some((c) => !c.connected);
  if (connected.length === 0) {
    return (
      <span className="relative">
        <IconPlug size={18} stroke={1.5} />
        {hasDisconnected && (
          <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500" />
        )}
      </span>
    );
  }
  return (
    <span className="flex items-center -space-x-1.5">
      {connected.map((c, i) => (
        <span
          key={c.type}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-full bg-background",
            i === connected.length - 1 && "relative",
          )}
          style={{ border: "0.7px solid hsl(var(--gray-400))" }}
        >
          {c.iconUrl ? (
            <img src={c.iconUrl} alt="" className="h-4 w-4" />
          ) : (
            <ConnectorIcon type={c.type as ConnectorType} size={16} />
          )}
          {hasDisconnected && i === connected.length - 1 && (
            <span className="absolute top-0 right-0 h-2 w-2 rounded-full bg-red-500 z-10" />
          )}
        </span>
      ))}
    </span>
  );
}

function ConnectorRow({
  item,
  action,
  tooltip,
}: {
  item: ComposerConnectorItem;
  action?: { label: string; onClick: () => void };
  tooltip?: string;
}) {
  const row = (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 transition-colors">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {item.iconUrl ? (
          <img src={item.iconUrl} alt="" className="h-4 w-4" />
        ) : (
          <ConnectorIcon type={item.type as ConnectorType} size={16} />
        )}
      </span>
      <span
        className={cn(
          "text-sm flex-1 truncate",
          item.connected ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {item.label}
      </span>
      {action && (
        <button
          type="button"
          className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            action.onClick();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );

  if (!tooltip) {
    return row;
  }

  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent side="right" className="max-w-[200px] text-xs">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ConnectorsPopoverButton({
  agentConnectors,
  onOpenAddDialog,
  onConnect,
  onManageConnectors,
  agentName,
}: {
  agentConnectors: ComposerConnectorItem[];
  onOpenAddDialog: () => void;
  onConnect: (type: string) => void;
  onManageConnectors?: () => void;
  agentName: string;
}) {
  const hasAgentConnectors = agentConnectors.length > 0;
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
                <ConnectorTriggerIcons connectors={agentConnectors} />
              </button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent side="top" className="text-xs">
            Connectors
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent side="top" align="start" className="w-64 p-0 rounded-lg">
        {hasAgentConnectors && (
          <div
            className="max-h-[200px] overflow-y-auto py-1 pl-1"
            style={{ scrollbarWidth: "thin" }}
          >
            <div className="px-2 pt-1 pb-1">
              <span className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
                Connectors used by {agentName}
              </span>
            </div>
            <div className="flex flex-col">
              {agentConnectors.map((item) => (
                <ConnectorRow
                  key={item.type}
                  item={item}
                  action={
                    item.connected
                      ? undefined
                      : {
                          label: "Connect",
                          onClick: () => onConnect(item.type),
                        }
                  }
                  tooltip={
                    item.connected
                      ? undefined
                      : "This connector is used by the agent but not connected. Click Connect to set it up, or go to Manage connectors for bulk setup."
                  }
                />
              ))}
            </div>
          </div>
        )}
        <div
          className={cn(
            "p-1 flex flex-col",
            hasAgentConnectors && "border-t border-border/50",
          )}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 px-2 py-1.5 rounded-md text-sm text-foreground hover:bg-accent transition-colors"
            onClick={() => onOpenAddDialog()}
          >
            <IconPlus
              size={18}
              stroke={1.5}
              className="shrink-0 text-muted-foreground"
            />
            Add connector
          </button>
          {onManageConnectors && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-2 py-1.5 rounded-md text-sm text-foreground hover:bg-accent transition-colors"
              onClick={onManageConnectors}
            >
              <IconPlug
                size={18}
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

  const agentConnectors: ComposerConnectorItem[] = addedSkills
    .filter((name) => connectorMap.has(name as ConnectorType))
    .map((name) =>
      buildConnectorItem(name, skillMap, connectorMap, optimisticConnected),
    )
    .sort((a, b) => Number(a.connected) - Number(b.connected));

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
                  agentConnectors={agentConnectors}
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
        agentName={agentName}
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
