import { useState, type ChangeEvent } from "react";
import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  IconArrowUp,
  IconPaperclip,
  IconPlayerStop,
  IconPlug,
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
  composerFileInput$,
  setComposerFileInput$,
} from "../../signals/zero-page/zero-chat.ts";
import { AttachmentChips } from "./zero-attachment-chips.tsx";
import { useFileUploadHandlers } from "./use-file-upload-handlers.ts";
import { useModelSelection } from "./zero-model-preference.ts";
import { useSendKeyHandler } from "./zero-send-key.ts";
import type { ConnectorType } from "@vm0/core";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { ProviderIcon } from "./components/settings/provider-icons.tsx";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import {
  allConnectorTypes$,
  selectedConnectorType$,
  setSelectedConnectorType$,
  justConnectedTypes$,
  clearJustConnectedTypes$,
} from "../../signals/zero-page/settings/connectors.ts";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import {
  zeroAddedConnectors$,
  addZeroConnector$,
  removeZeroConnector$,
  saveZeroConnectors$,
} from "../../signals/zero-page/zero-connectors.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
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
  added: boolean;
}

function maybeClearOptimistic(
  optimistic: Set<string>,
  connectorMap: Map<ConnectorType, { connected: boolean }>,
  clear: () => void,
) {
  if (optimistic.size === 0) {
    return;
  }
  const allConfirmed = [...optimistic].every((t) => {
    return connectorMap.get(t as ConnectorType)?.connected;
  });
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
  const connected = connectors
    .filter((c) => {
      return c.connected;
    })
    .slice(0, 3);
  if (connected.length === 0) {
    return <IconPlug size={18} stroke={1.5} />;
  }
  return (
    <span className="flex items-center -space-x-1.5">
      {connected.map((c) => {
        return (
          <span key={c.type} className="relative shrink-0">
            <span className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-background zero-border">
              <ConnectorIcon type={c.type as ConnectorType} size={16} />
            </span>
          </span>
        );
      })}
    </span>
  );
}

function ConnectorsPopoverButton({
  agentConnectors,
  connectorsLoading,
  savingType,
  onOpenAddDialog,
  onToggle,
  displayName,
}: {
  agentConnectors: ComposerConnectorItem[];
  connectorsLoading: boolean;
  savingType: string | null;
  onOpenAddDialog: () => void;
  onToggle: (type: string, checked: boolean) => void;
  displayName: string;
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
        <div className="py-1">
          <div className="px-3 pt-2 pb-1">
            <span className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
              Services for {displayName}
            </span>
          </div>
          {connectorsLoading ? (
            <div className="flex flex-col animate-pulse">
              {Array.from({ length: 3 }, (_, i) => {
                return (
                  <div key={i} className="flex items-center gap-2 px-3 py-2">
                    <span className="h-4 w-4 shrink-0 rounded bg-muted/50" />
                    <span className="h-3.5 w-20 rounded bg-muted/50 flex-1" />
                    <span className="h-3 w-6 rounded-full bg-muted/50" />
                  </div>
                );
              })}
            </div>
          ) : agentConnectors.length > 0 ? (
            <div className="flex flex-col">
              {agentConnectors.map((item) => {
                return (
                  <div
                    key={item.type}
                    className="flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors"
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                      <ConnectorIcon
                        type={item.type as ConnectorType}
                        size={16}
                      />
                    </span>
                    <span className="text-sm flex-1 truncate text-foreground">
                      {item.label}
                    </span>
                    <LoadingSwitch
                      checked={item.added}
                      onCheckedChange={(checked) => {
                        onToggle(item.type, checked);
                      }}
                      loading={savingType === item.type}
                      ariaLabel={`${item.added ? "Remove" : "Add"} ${item.label}`}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
        <div
          className={cn(
            "p-1 flex flex-col",
            (agentConnectors.length > 0 || connectorsLoading) &&
              "border-t border-border/50",
          )}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 px-2 py-1.5 rounded-md text-sm text-foreground hover:bg-accent transition-colors"
            onClick={() => {
              return onOpenAddDialog();
            }}
          >
            <IconPlug
              size={18}
              stroke={1.5}
              className="shrink-0 text-muted-foreground"
            />
            Manage connectors
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
  displayName,
  className,
  autoFocus,
}: ZeroChatComposerProps) {
  // Attachments
  const attachments = useGet(zeroChatAttachments$);
  const uploadAttachment = useSet(uploadZeroAttachment$);
  const removeAttachment = useSet(removeZeroAttachment$);

  // File picker
  const fileInputEl = useGet(composerFileInput$);
  const setFileInputEl = useSet(setComposerFileInput$);

  // File upload (paste / drag-drop)
  const { dragOver, handlePaste, handleDrop, handleDragOver, handleDragLeave } =
    useFileUploadHandlers();

  // Model selection
  const { modelOptions, selectedModel, setSelectedModel, persistSelection } =
    useModelSelection();

  // Upload signal — uses rootSignal so uploads survive page navigation
  const { signal: rootSignal } = useGet(rootSignal$);

  // Connectors
  const allTypesLoadable = useLastLoadable(allConnectorTypes$);
  const addedConnectorsLoadable = useLastLoadable(zeroAddedConnectors$);
  const pageSignal = useGet(pageSignal$);
  const selectedConnType = useGet(selectedConnectorType$);
  const setSelectedConnType = useSet(setSelectedConnectorType$);
  const addConnector = useSet(addZeroConnector$);
  const removeConnector = useSet(removeZeroConnector$);
  const saveConnectors = useSet(saveZeroConnectors$);
  const optimisticConnected = useGet(justConnectedTypes$);
  const clearOptimistic = useSet(clearJustConnectedTypes$);
  const navigate = useSet(detachedNavigateTo$);

  const [savingType, setSavingType] = useState<string | null>(null);

  const connectorsLoading =
    allTypesLoadable.state !== "hasData" ||
    addedConnectorsLoadable.state !== "hasData";

  const allConnectors =
    allTypesLoadable.state === "hasData" ? allTypesLoadable.data : [];
  const connectorMap = new Map(
    allConnectors.map((c) => {
      return [c.type, c];
    }),
  );
  maybeClearOptimistic(optimisticConnected, connectorMap, clearOptimistic);
  const addedConnectors =
    addedConnectorsLoadable.state === "hasData"
      ? addedConnectorsLoadable.data
      : [];
  const addedSet = new Set(addedConnectors);

  // Show all org-connected services (so user can toggle them on/off for this agent)
  const connectedTypes = allConnectors.filter((c) => {
    return c.connected || optimisticConnected.has(c.type);
  });
  const agentConnectors: ComposerConnectorItem[] = connectedTypes.map((c) => {
    return {
      type: c.type,
      label: c.label,
      connected: c.connected || optimisticConnected.has(c.type),
      added: addedSet.has(c.type),
    };
  });

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

  const handleToggle = (type: string, checked: boolean) => {
    setSavingType(type);
    detach(
      (async () => {
        if (checked) {
          await addConnector(type, pageSignal);
        } else {
          await removeConnector(type, pageSignal);
        }
        try {
          await saveConnectors(pageSignal);
        } catch (error) {
          throwIfAbort(error);
        } finally {
          setSavingType(null);
        }
      })(),
      Reason.DomCallback,
    );
  };

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || sending) {
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
      detach(uploadAttachment(file, rootSignal), Reason.DomCallback);
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
                onRemove={(attachment) => {
                  return removeAttachment(attachment);
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
              onChange={(e) => {
                return onInputChange(e.target.value);
              }}
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
                  connectorsLoading={connectorsLoading}
                  savingType={savingType}
                  onOpenAddDialog={() => {
                    return navigate("/connectors");
                  }}
                  onToggle={handleToggle}
                  displayName={displayName}
                />
              </div>
              <div className="flex items-center gap-2">
                <Select value={selectedModel} onValueChange={setSelectedModel}>
                  <SelectTrigger className="h-9 min-w-[100px] gap-1 rounded-lg border-none bg-transparent text-sm text-foreground shadow-none hover:bg-accent transition-colors [&>svg]:h-5 [&>svg]:w-5 [&>svg]:opacity-80">
                    <SelectValue placeholder="Model" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.map((opt) => {
                      return (
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
                      );
                    })}
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
      {selectedConnType && (
        <ConnectModal
          onClose={() => {
            return setSelectedConnType(null);
          }}
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
