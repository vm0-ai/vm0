import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { CircleCheck, Copy, EllipsisVertical } from "lucide-react";
import { Button } from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui/components/ui/tooltip";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  agentPhoneLinkStatus$,
  agentPhoneConnectDialogOpen$,
  disconnectAgentPhone$,
  setAgentPhoneConnectDialogOpen$,
} from "../../signals/okou-page/agentphone.ts";
import { writeToClipboard } from "../../signals/okou-page/clipboard.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";

const imessageIconImg = settingsIconAssetUrl("imessage");

/** Render a US/Canada E.164 number as `+1 (NXX) NXX-XXXX`; other formats are
 *  returned unchanged. */
function formatAgentPhoneNumber(raw: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/u.exec(raw);
  if (!match) {
    return raw;
  }
  return `+1 (${match[1]}) ${match[2]}-${match[3]}`;
}

function PhoneNumberCopyButton({
  phoneNumber,
}: {
  readonly phoneNumber: string;
}) {
  const { t } = useTranslation();
  const formatted = formatAgentPhoneNumber(phoneNumber);

  return (
    <IconTooltipButton
      type="button"
      aria-label={t(
        ($) => {
          return $.connectors.providerSettings.agentphone.copyAria;
        },
        { phone: formatted },
      )}
      className="inline-flex items-center gap-1 rounded font-medium text-foreground transition-colors hover:text-foreground/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      onClick={() => {
        detach(
          (async () => {
            const copied = await writeToClipboard(phoneNumber);
            if (copied) {
              toast.success(
                i18n.t(($) => {
                  return $.connectors.providerSettings.agentphone.copySuccess;
                }),
              );
            } else {
              toast.error(
                i18n.t(($) => {
                  return $.connectors.providerSettings.agentphone.copyError;
                }),
              );
            }
          })(),
          Reason.DomCallback,
        );
      }}
    >
      {formatted}
      <Copy size={13} className="shrink-0 text-muted-foreground" />
    </IconTooltipButton>
  );
}

function AgentPhoneConnectActions({
  messageHref,
  onClose,
}: {
  readonly messageHref: string;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <DialogFooter>
      <Button type="button" variant="outline" onClick={onClose}>
        {t(($) => {
          return $.connectors.actions.close;
        })}
      </Button>
      <Button asChild>
        <a href={messageHref}>
          {t(($) => {
            return $.connectors.providerSettings.agentphone.openMessages;
          })}
        </a>
      </Button>
    </DialogFooter>
  );
}

function AgentPhoneConnectIntro() {
  const { t } = useTranslation();
  return (
    <DialogHeader>
      <DialogTitle>
        {t(($) => {
          return $.connectors.providerSettings.agentphone.connectTitle;
        })}
      </DialogTitle>
      <DialogDescription>
        {t(($) => {
          return $.connectors.providerSettings.agentphone.connectDescription;
        })}
      </DialogDescription>
    </DialogHeader>
  );
}

function AgentPhoneConnectDialog({
  phoneNumber,
}: {
  readonly phoneNumber: string | null;
}) {
  const { t } = useTranslation();
  const open = useGet(agentPhoneConnectDialogOpen$);
  const setOpen = useSet(setAgentPhoneConnectDialogOpen$);
  if (!phoneNumber) {
    return null;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
      }}
    >
      <DialogContent>
        <AgentPhoneConnectIntro />
        <div className="grid gap-3">
          <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
            <p className="text-sm text-muted-foreground">
              {t(($) => {
                return $.connectors.providerSettings.agentphone
                  .messageInstruction;
              })}
            </p>
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
              <span className="inline-flex min-w-0 items-center gap-2">
                <img src={imessageIconImg} alt="" className="h-5 w-5" />
                <PhoneNumberCopyButton phoneNumber={phoneNumber} />
              </span>
              <span className="shrink-0 rounded-full bg-primary px-3 py-1 text-sm font-medium text-primary-foreground">
                hi
              </span>
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              {t(($) => {
                return $.connectors.providerSettings.agentphone
                  .replyInstruction;
              })}
            </p>
          </div>
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
            {t(($) => {
              return $.connectors.providerSettings.agentphone.risk;
            })}
          </div>
          <AgentPhoneConnectActions
            messageHref={`sms:${phoneNumber}`}
            onClose={() => {
              setOpen(false);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AgentPhoneCardActions({
  canConnect,
}: {
  readonly canConnect: boolean;
}) {
  const { t } = useTranslation();
  const statusLoadable = useLastLoadable(agentPhoneLinkStatus$);
  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const [disconnectLoadable, disconnect] = useLoadableSet(
    disconnectAgentPhone$,
  );
  const pageSignal = useGet(pageSignal$);
  const setConnectOpen = useSet(setAgentPhoneConnectDialogOpen$);
  const disconnecting = disconnectLoadable.state === "loading";
  const isConnected = status?.linked ?? false;
  const connectedPhone = status?.linked ? status.phoneHandle : null;

  return (
    <>
      {isConnected ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-testid="agentphone-connected-indicator"
                className="inline-flex min-w-0 max-w-52 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground"
              >
                <CircleCheck className="h-3 w-3 text-green-600" />
                <span className="min-w-0 truncate">
                  {connectedPhone ??
                    t(($) => {
                      return $.connectors.providerSettings.works.connected;
                    })}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t(($) => {
                return $.connectors.providerSettings.agentphone
                  .authorizedSender;
              })}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
      {status !== null && !isConnected && canConnect ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          aria-label={t(($) => {
            return $.connectors.providerSettings.agentphone.connectAria;
          })}
          onClick={() => {
            setConnectOpen(true);
          }}
        >
          {t(($) => {
            return $.connectors.actions.connect;
          })}
        </Button>
      ) : null}
      {isConnected ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              showTooltip
              type="button"
              variant="quiet"
              size="icon-xs"
              className="shrink-0"
              aria-label={t(($) => {
                return $.connectors.providerSettings.agentphone.options;
              })}
            >
              <EllipsisVertical size={16} />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="flex flex-col gap-0.5 w-40 p-2"
          >
            <button
              type="button"
              aria-label={t(($) => {
                return $.connectors.actions.disconnect;
              })}
              disabled={disconnecting}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-state-hover hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none"
              onClick={() => {
                return detach(disconnect(pageSignal), Reason.DomCallback);
              }}
            >
              {disconnecting
                ? t(($) => {
                    return $.connectors.actions.disconnecting;
                  })
                : t(($) => {
                    return $.connectors.actions.disconnect;
                  })}
            </button>
          </PopoverContent>
        </Popover>
      ) : null}
    </>
  );
}

export function AgentPhoneCard() {
  const { t } = useTranslation();
  const statusLoadable = useLastLoadable(agentPhoneLinkStatus$);
  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const agentPhoneNumber = status?.agentPhoneNumber ?? null;

  return (
    <>
      <div className="zero-card flex flex-col">
        <div className="flex items-center gap-4 p-4">
          <div className="shrink-0 inline-flex h-7 w-7 items-center justify-center overflow-hidden">
            <img src={imessageIconImg} alt="" className="h-7 w-7" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <div className="truncate text-sm font-medium text-foreground">
                {t(($) => {
                  return $.connectors.providerSettings.agentphone.phoneLabel;
                })}
              </div>
            </div>
            <div className="truncate text-sm text-muted-foreground">
              {agentPhoneNumber ? (
                <span className="inline-flex max-w-full items-center gap-1">
                  <span className="shrink-0">
                    {t(($) => {
                      return $.connectors.providerSettings.agentphone
                        .destination;
                    })}
                  </span>
                  <PhoneNumberCopyButton phoneNumber={agentPhoneNumber} />
                </span>
              ) : (
                t(($) => {
                  return $.connectors.providerSettings.agentphone.description;
                })
              )}
            </div>
          </div>
          <AgentPhoneCardActions canConnect={agentPhoneNumber !== null} />
        </div>
      </div>
      <AgentPhoneConnectDialog phoneNumber={agentPhoneNumber} />
    </>
  );
}
