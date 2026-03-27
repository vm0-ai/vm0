import type { ChangeEvent } from "react";
import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  IconArrowUp,
  IconArrowUpRight,
  IconPaperclip,
  IconPlayerStop,
  IconPlug,
  IconPlus,
  IconClock,
  IconArrowBackUp,
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
  Switch,
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
import {
  AddConnectionDialog,
  ConnectModal,
} from "./components/settings/add-connection-dialog.tsx";
import {
  allConnectorTypes$,
  selectedConnectorType$,
  setSelectedConnectorType$,
  justConnectedTypes$,
  clearJustConnectedTypes$,
} from "../../signals/zero-page/settings/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  zeroAddedConnectors$,
  addZeroConnector$,
  removeZeroConnector$,
  saveZeroConnectors$,
  zeroAgentId$,
} from "../../signals/zero-page/zero-connectors.ts";
import { navigateTo$ } from "../../signals/route.ts";
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
  /** Message queued for delivery after the current run completes. */
  queuedMessage?: { text: string } | null;
  /** Withdraw the queued message back into the input for editing. */
  onWithdraw?: () => void;
  displayName: string;
  className?: string;
  /** Auto-focus the textarea when mounted. */
  autoFocus?: boolean;
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

function ConnectorsPopoverButton({
  agentConnectors,
  allOrgConnectors,
  addedSet,
  onToggleConnector,
  onOpenAddDialog,
  onNavigateToAuthorization,
}: {
  agentConnectors: ComposerConnectorItem[];
  allOrgConnectors: { type: string; label: string; connected: boolean }[];
  addedSet: Set<string>;
  onToggleConnector: (type: string, enabled: boolean) => void;
  onOpenAddDialog: () => void;
  onNavigateToAuthorization?: () => void;
}) {
  const orgConnected = allOrgConnectors.filter((c) => c.connected);
  const hasOrgConnected = orgConnected.length > 0;
  const visibleConnected = orgConnected.slice(0, 20);
  const hasMore = orgConnected.length > 20 && !!onNavigateToAuthorization;
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
      <PopoverContent side="top" align="start" className="w-72 p-0 rounded-lg">
        {hasOrgConnected ? (
          <div
            className="max-h-[240px] overflow-y-auto py-1"
            style={{ scrollbarWidth: "thin" }}
          >
            <div className="flex flex-col">
              {visibleConnected.map((c) => {
                const granted = addedSet.has(c.type);
                return (
                  <label
                    key={c.type}
                    className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-accent transition-colors"
                  >
                    <ConnectorIcon type={c.type as ConnectorType} size={18} />
                    <span className="flex-1 min-w-0 text-sm text-foreground truncate">
                      {c.label}
                    </span>
                    <Switch
                      size="sm"
                      checked={granted}
                      onCheckedChange={(checked) =>
                        onToggleConnector(c.type, checked)
                      }
                    />
                  </label>
                );
              })}
              {hasMore && (
                <button
                  type="button"
                  className="flex items-center gap-2.5 px-3 py-2 hover:bg-accent transition-colors text-left"
                  onClick={onNavigateToAuthorization}
                >
                  <IconArrowUpRight
                    size={18}
                    stroke={1.5}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="flex-1 min-w-0 text-sm text-foreground truncate">
                    View all {orgConnected.length}
                  </span>
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="px-3 py-3">
            <p className="text-xs text-muted-foreground">
              No connected services yet.
            </p>
          </div>
        )}
        <div className="p-1 border-t border-border/50">
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
            Browse more connectors
          </button>
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
  queuedMessage,
  onWithdraw,
  displayName,
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

  // Navigation
  const navigateTo = useSet(navigateTo$);
  const agentIdLoadable = useLastLoadable(zeroAgentId$);
  const resolvedAgentId =
    agentIdLoadable.state === "hasData" ? agentIdLoadable.data : null;

  // Connectors
  const allTypesLoadable = useLastLoadable(allConnectorTypes$);
  const addedConnectorsLoadable = useLastLoadable(zeroAddedConnectors$);
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
  const connectedTypes = new Set(
    allConnectors.filter((c) => c.connected).map((c) => c.type),
  );
  const dialogExcludeTypes = new Set([...addedSet, ...connectedTypes]);

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

  const removeConnector = useSet(removeZeroConnector$);
  const handleToggleConnector = (type: string, enabled: boolean) => {
    if (enabled) {
      detach(
        (async () => {
          await addConnector(type, pageSignal);
          try {
            await saveConnectors(pageSignal);
          } catch (error) {
            throwIfAbort(error);
          }
        })(),
        Reason.DomCallback,
      );
    } else {
      detach(
        (async () => {
          await removeConnector(type, pageSignal);
          try {
            await saveConnectors(pageSignal);
          } catch (error) {
            throwIfAbort(error);
          }
        })(),
        Reason.DomCallback,
      );
    }
  };

  // Send (or queue if agent is busy — parent decides)
  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || !!queuedMessage) {
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
            {queuedMessage ? (
              <div className="flex items-start gap-3 px-5 pt-4 pb-2 min-h-[88px]">
                <IconClock
                  size={16}
                  className="text-muted-foreground shrink-0 mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-muted-foreground mb-1">
                    Will send when the agent finishes
                  </p>
                  <p className="text-sm text-foreground line-clamp-3 break-words">
                    {queuedMessage.text}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onWithdraw}
                  className="shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <IconArrowBackUp size={14} />
                  Withdraw
                </button>
              </div>
            ) : (
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
            )}
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
                  allOrgConnectors={allConnectors}
                  addedSet={addedSet}
                  onToggleConnector={handleToggleConnector}
                  onOpenAddDialog={() => setAddDialogOpen(true)}
                  onNavigateToAuthorization={
                    resolvedAgentId
                      ? () =>
                          navigateTo("/team/:agentId", {
                            pathParams: { agentId: resolvedAgentId },
                          })
                      : undefined
                  }
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
                {!queuedMessage && (
                  <Button
                    size="sm"
                    className="rounded-lg h-9 w-9 p-0 shrink-0"
                    onClick={handleSend}
                    disabled={!input.trim()}
                    aria-label={sending ? "Queue message" : "Send"}
                  >
                    <IconArrowUp size={16} stroke={2} />
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
        excludeTypes={dialogExcludeTypes}
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
