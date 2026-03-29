import { useState, type ChangeEvent } from "react";
import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  IconArrowUp,
  IconPaperclip,
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
  cancelZeroAttachmentUpload$,
  composerFileInput$,
  setComposerFileInput$,
  composerAddDialogOpen$,
  setComposerAddDialogOpen$,
} from "../../signals/zero-page/zero-chat.ts";
import { AttachmentChips } from "./zero-attachment-chips.tsx";
import { useFileUploadHandlers } from "./use-file-upload-handlers.ts";
import { useModelSelection } from "./zero-model-preference.ts";
import { useSendKeyHandler } from "./zero-send-key.ts";
import type { ConnectorType } from "@vm0/core";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { ProviderIcon } from "./components/settings/provider-icons.tsx";
import {
  AddConnectionDialog,
  ConnectModal,
} from "./components/settings/add-connection-dialog.tsx";
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
  zeroAddedConnectors$,
  addZeroConnector$,
  saveZeroConnectors$,
} from "../../signals/zero-page/zero-connectors.ts";
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
  displayName: string;
  /** Navigate to connectors management page. */
  onManageConnectors?: () => void;
  className?: string;
  /** Auto-focus the textarea when mounted. */
  autoFocus?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildModelOpts(model: string): { modelProvider: string } | undefined {
  return model ? { modelProvider: model } : undefined;
}

interface ComposerConnectorItem {
  type: string;
  label: string;
  connected: boolean;
}

function buildConnectorItem(
  name: string,
  connectorMap: Map<ConnectorType, { label: string; connected: boolean }>,
  optimistic: Set<string>,
): ComposerConnectorItem {
  const connector = connectorMap.get(name as ConnectorType);
  return {
    type: name,
    label: connector?.label ?? name,
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
  connectorMap: Map<ConnectorType, { label: string }>,
): string {
  return connectorMap.get(type as ConnectorType)?.label ?? type;
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
  if (connected.length === 0) {
    return <IconPlug size={18} stroke={1.5} />;
  }
  return (
    <span className="flex items-center -space-x-1.5">
      {connected.map((c) => (
        <span key={c.type} className="relative shrink-0">
          <span
            className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-background"
            style={{ border: "0.7px solid hsl(var(--gray-400))" }}
          >
            <ConnectorIcon type={c.type as ConnectorType} size={16} />
          </span>
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
  const [hoverTooltipOpen, setHoverTooltipOpen] = useState(false);

  const row = (
    <div
      className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 transition-colors"
      {...(tooltip
        ? {
            onPointerEnter: () => setHoverTooltipOpen(true),
            onPointerLeave: () => setHoverTooltipOpen(false),
          }
        : {})}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <ConnectorIcon type={item.type as ConnectorType} size={16} />
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
    <Tooltip
      delayDuration={0}
      disableHoverableContent
      open={hoverTooltipOpen}
      onOpenChange={(next) => {
        if (!next) {
          setHoverTooltipOpen(false);
        }
      }}
    >
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-[200px] text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

function ConnectorsPopoverButton({
  agentConnectors,
  onOpenAddDialog,
  onConnect,
  onManageConnectors,
  displayName,
}: {
  agentConnectors: ComposerConnectorItem[];
  onOpenAddDialog: () => void;
  onConnect: (type: string) => void;
  onManageConnectors?: () => void;
  displayName: string;
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
                aria-label="Connectors"
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
          <TooltipProvider delayDuration={400}>
            <div
              className="max-h-[200px] overflow-y-auto py-1 pl-1"
              style={{ scrollbarWidth: "thin" }}
            >
              <div className="px-2 pt-1 pb-1">
                <span className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
                  Connectors used by {displayName}
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
          </TooltipProvider>
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
              Manage connectors in {displayName}
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
  displayName,
  onManageConnectors,
  className,
  autoFocus,
}: ZeroChatComposerProps) {
  // Attachments
  const attachments = useGet(zeroChatAttachments$);
  const uploadAttachment = useSet(uploadZeroAttachment$);
  const removeAttachment = useSet(removeZeroAttachment$);
  const cancelUpload = useSet(cancelZeroAttachmentUpload$);

  // File picker
  const fileInputEl = useGet(composerFileInput$);
  const setFileInputEl = useSet(setComposerFileInput$);

  // File upload (paste / drag-drop)
  const { dragOver, handlePaste, handleDrop, handleDragOver, handleDragLeave } =
    useFileUploadHandlers();

  // Model selection
  const { modelOptions, selectedModel, setSelectedModel, persistSelection } =
    useModelSelection();

  // Connectors
  const allTypesLoadable = useLastLoadable(allConnectorTypes$);
  const addedConnectorsLoadable = useLastLoadable(zeroAddedConnectors$);
  const connectConnector = useSet(connectConnector$);
  const pageSignal = useGet(pageSignal$);
  const selectedConnType = useGet(selectedConnectorType$);
  const setSelectedConnType = useSet(setSelectedConnectorType$);
  const addConnector = useSet(addZeroConnector$);
  const saveConnectors = useSet(saveZeroConnectors$);
  const optimisticConnected = useGet(justConnectedTypes$);
  const clearOptimistic = useSet(clearJustConnectedTypes$);
  const addDialogOpen = useGet(composerAddDialogOpen$);
  const setAddDialogOpen = useSet(setComposerAddDialogOpen$);

  const allConnectors =
    allTypesLoadable.state === "hasData" ? allTypesLoadable.data : [];
  const connectorMap = new Map(allConnectors.map((c) => [c.type, c]));
  maybeClearOptimistic(optimisticConnected, connectorMap, clearOptimistic);
  const addedConnectors =
    addedConnectorsLoadable.state === "hasData"
      ? addedConnectorsLoadable.data
      : [];
  const addedSet = new Set(addedConnectors);

  const agentConnectors: ComposerConnectorItem[] = addedConnectors
    .filter((name) => connectorMap.has(name as ConnectorType))
    .map((name) => buildConnectorItem(name, connectorMap, optimisticConnected))
    .sort((a, b) => Number(a.connected) - Number(b.connected));

  const handleConnectSuccess = (type: string) => {
    const label = resolveConnectorLabel(type, connectorMap);
    detach(
      (async () => {
        await addConnector(type, pageSignal);
        try {
          await saveConnectors(pageSignal);
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

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }
    persistSelection();
    onSend(trimmed, buildModelOpts(selectedModel));
  };

  const {
    onKeyDown: handleKeyDown,
    onCompositionStart,
    onCompositionEnd,
  } = useSendKeyHandler(handleSend);

  const handleFileSelect = () => {
    fileInputEl?.click();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) {
      return;
    }
    for (const file of files) {
      detach(uploadAttachment(file, pageSignal), Reason.DomCallback);
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
                onRemove={(id) => {
                  const attachment = attachments.find((a) => a.id === id);
                  if (attachment?.uploading) {
                    cancelUpload(id);
                  } else {
                    removeAttachment(id);
                  }
                }}
              />
            )}
            <textarea
              ref={(el) => {
                if (el && autoFocus) {
                  el.focus();
                }
              }}
              className="w-full resize-none bg-transparent px-5 pt-4 pb-2 text-sm text-foreground placeholder:text-muted-foreground border-0 min-h-[88px] focus:outline-none focus:ring-0"
              rows={3}
              placeholder={
                sending
                  ? "Type your next message\u2026"
                  : "Ask me to automate workflows, manage tasks..."
              }
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              onPaste={handlePaste}
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
                  displayName={displayName}
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
                        <div className="flex items-center gap-2">
                          <ProviderIcon
                            type={
                              opt.value as Parameters<
                                typeof ProviderIcon
                              >[0]["type"]
                            }
                            size={16}
                          />
                          <span>{opt.label}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {sending && onCancel && (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="rounded-lg h-9 w-9 p-0 shrink-0"
                    onClick={onCancel}
                    aria-label="Stop"
                  >
                    <IconPlayerStop size={16} />
                  </Button>
                )}
                <Button
                  size="sm"
                  className="rounded-lg h-9 w-9 p-0 shrink-0"
                  onClick={handleSend}
                  disabled={!input.trim() || !!sending}
                  aria-label="Send"
                >
                  <IconArrowUp size={16} stroke={2} />
                </Button>
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
        displayName={displayName}
      />
      {selectedConnType && (
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
