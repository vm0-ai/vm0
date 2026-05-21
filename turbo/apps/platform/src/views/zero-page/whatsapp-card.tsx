import type { FormEvent } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconBrandWhatsapp,
  IconCircleCheck,
  IconCopy,
  IconDotsVertical,
  IconLoader2,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import { Input } from "@vm0/ui/components/ui/input";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  disconnectWhatsApp$,
  resetWhatsAppConnectUi$,
  setWhatsAppConnectDialogOpen$,
  setWhatsAppPhoneForm$,
  setWhatsAppShowPhoneError$,
  setWhatsAppVerificationPhone$,
  startWhatsAppLink$,
  waitForWhatsAppConnection$,
  whatsAppConnectDialogOpen$,
  whatsAppLinkStatus$,
  whatsAppPhoneForm$,
  whatsAppPhoneFormError$,
  whatsAppPhoneFormNormalized$,
  whatsAppShowPhoneError$,
  whatsAppVerificationPhone$,
} from "../../signals/zero-page/zero-whatsapp.ts";
import { writeToClipboard } from "../../signals/zero-page/clipboard.ts";
import { detach, Reason } from "../../signals/utils.ts";

function formatWhatsAppNumber(raw: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/u.exec(raw);
  if (!match) {
    return raw;
  }
  return `+1 (${match[1]}) ${match[2]}-${match[3]}`;
}

function WhatsAppNumberCopyButton({
  phoneNumber,
}: {
  readonly phoneNumber: string;
}) {
  const formatted = formatWhatsAppNumber(phoneNumber);

  return (
    <button
      type="button"
      aria-label={`Copy ${formatted}`}
      className="inline-flex items-center gap-1 rounded font-medium text-foreground transition-colors hover:text-foreground/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      onClick={() => {
        detach(
          (async () => {
            const copied = await writeToClipboard(phoneNumber);
            if (copied) {
              toast.success("WhatsApp number copied");
            } else {
              toast.error("Failed to copy WhatsApp number");
            }
          })(),
          Reason.DomCallback,
        );
      }}
    >
      {formatted}
      <IconCopy size={13} className="shrink-0 text-muted-foreground" />
    </button>
  );
}

function WhatsAppVerificationStatus({
  verificationPhone,
  connecting,
}: {
  readonly verificationPhone: string | null;
  readonly connecting: boolean;
}) {
  if (!verificationPhone) {
    return null;
  }

  return (
    <div
      className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground"
      role="status"
    >
      <span className="flex items-center gap-2">
        {connecting ? (
          <IconLoader2 size={14} className="shrink-0 animate-spin" />
        ) : (
          <IconCircleCheck size={14} className="shrink-0 text-green-600" />
        )}
        <span>
          Verification message sent to {verificationPhone}. Open the link in
          WhatsApp to finish connecting.
        </span>
      </span>
    </div>
  );
}

function WhatsAppConnectActions({
  starting,
  connecting,
  normalizedPhone,
  phoneError,
  onCancel,
}: {
  readonly starting: boolean;
  readonly connecting: boolean;
  readonly normalizedPhone: string;
  readonly phoneError: string | null;
  readonly onCancel: () => void;
}) {
  const busy = starting || connecting;

  return (
    <DialogFooter>
      <Button
        type="button"
        variant="outline"
        disabled={starting}
        onClick={onCancel}
      >
        Cancel
      </Button>
      <Button
        type="submit"
        disabled={!normalizedPhone || Boolean(phoneError) || busy}
      >
        {busy ? <IconLoader2 size={14} className="animate-spin" /> : null}
        {starting
          ? "Sending..."
          : connecting
            ? "Connecting..."
            : "Send verification"}
      </Button>
    </DialogFooter>
  );
}

function WhatsAppConnectDialog() {
  const open = useGet(whatsAppConnectDialogOpen$);
  const phoneForm = useGet(whatsAppPhoneForm$);
  const normalizedPhone = useLastResolved(whatsAppPhoneFormNormalized$) ?? "";
  const phoneError = useLastResolved(whatsAppPhoneFormError$) ?? null;
  const verificationPhone = useLastResolved(whatsAppVerificationPhone$) ?? null;
  const showPhoneError = useLastResolved(whatsAppShowPhoneError$) ?? false;
  const setPhoneForm = useSet(setWhatsAppPhoneForm$);
  const setOpen = useSet(setWhatsAppConnectDialogOpen$);
  const setVerificationPhone = useSet(setWhatsAppVerificationPhone$);
  const setShowPhoneError = useSet(setWhatsAppShowPhoneError$);
  const resetConnectUi = useSet(resetWhatsAppConnectUi$);
  const pageSignal = useGet(pageSignal$);
  const [startLoadable, startLink] = useLoadableSet(startWhatsAppLink$);
  const [connectLoadable, waitForConnection] = useLoadableSet(
    waitForWhatsAppConnection$,
  );
  const starting = startLoadable.state === "loading";
  const connecting = connectLoadable.state === "loading";
  const busy = starting || connecting;
  const visiblePhoneError = showPhoneError ? phoneError : null;

  const close = (nextOpen: boolean) => {
    if (!nextOpen && starting) {
      return;
    }
    if (!nextOpen && !connecting) {
      resetConnectUi();
    }
    setOpen(nextOpen);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedPhone || phoneError || busy) {
      setShowPhoneError(true);
      return;
    }
    setVerificationPhone(null);
    setShowPhoneError(false);
    detach(
      (async () => {
        const result = await startLink(pageSignal);
        setVerificationPhone(result.phoneHandle);
        await waitForConnection(pageSignal);
        if (!pageSignal.aborted) {
          close(false);
        }
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect WhatsApp</DialogTitle>
          <DialogDescription>
            Enter your WhatsApp phone number. We will send a verification link
            that connects this workspace.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
          If WhatsApp blocks the first verification message, send /connect to
          the shared number first.
        </div>
        <form className="grid gap-3" onSubmit={submit}>
          <label
            htmlFor="whatsapp-phone-input"
            className="text-sm font-medium text-foreground"
          >
            Phone number
          </label>
          <Input
            id="whatsapp-phone-input"
            data-testid="whatsapp-phone-input"
            type="tel"
            inputMode="tel"
            placeholder="+1 555 555 1212"
            value={phoneForm}
            disabled={busy}
            onBlur={() => {
              setShowPhoneError(true);
            }}
            onChange={(event) => {
              setVerificationPhone(null);
              setPhoneForm(event.target.value);
            }}
            onFocus={() => {
              setShowPhoneError(false);
            }}
          />
          {normalizedPhone ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="whatsapp-normalized-phone"
            >
              We will message {normalizedPhone}.
            </p>
          ) : null}
          {visiblePhoneError ? (
            <p className="text-sm text-destructive" role="alert">
              {visiblePhoneError}
            </p>
          ) : null}
          <WhatsAppVerificationStatus
            verificationPhone={verificationPhone}
            connecting={connecting}
          />
          <WhatsAppConnectActions
            starting={starting}
            connecting={connecting}
            normalizedPhone={normalizedPhone}
            phoneError={phoneError}
            onCancel={() => {
              close(false);
            }}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WhatsAppCard() {
  const statusLoadable = useLastLoadable(whatsAppLinkStatus$);
  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const [disconnectLoadable, disconnect] = useLoadableSet(disconnectWhatsApp$);
  const pageSignal = useGet(pageSignal$);
  const setConnectOpen = useSet(setWhatsAppConnectDialogOpen$);
  const disconnecting = disconnectLoadable.state === "loading";
  const isConnected = status?.linked ?? false;
  const connectedPhone = status?.linked ? status.phoneHandle : null;
  const whatsAppNumber = status?.whatsAppNumber ?? null;

  return (
    <>
      <div className="zero-card flex flex-col">
        <div className="flex items-center gap-4 p-4">
          <div className="shrink-0 inline-flex h-7 w-7 items-center justify-center overflow-hidden text-[#25D366]">
            <IconBrandWhatsapp size={28} stroke={1.7} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <div className="truncate text-sm font-medium text-foreground">
                WhatsApp
              </div>
            </div>
            <div className="truncate text-sm text-muted-foreground">
              {whatsAppNumber ? (
                <span className="inline-flex max-w-full items-center gap-1">
                  <span className="shrink-0">Message Zero at</span>
                  <WhatsAppNumberCopyButton phoneNumber={whatsAppNumber} />
                </span>
              ) : (
                "WhatsApp messaging through Twilio"
              )}
            </div>
          </div>
          {isConnected ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    data-testid="whatsapp-connected-indicator"
                    className="inline-flex min-w-0 max-w-52 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground"
                  >
                    <IconCircleCheck className="h-3 w-3 text-green-600" />
                    <span className="min-w-0 truncate">
                      {connectedPhone ?? "Connected"}
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Authorized WhatsApp sender</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          {status !== null && !isConnected ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1.5 rounded-lg"
              aria-label="Connect WhatsApp"
              onClick={() => {
                setConnectOpen(true);
              }}
            >
              Connect
            </Button>
          ) : null}
          {isConnected ? (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  aria-label="WhatsApp options"
                >
                  <IconDotsVertical size={16} stroke={1.5} />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="flex flex-col gap-0.5 w-40 p-2"
              >
                <button
                  type="button"
                  aria-label="Disconnect WhatsApp"
                  disabled={disconnecting}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none"
                  onClick={() => {
                    return detach(disconnect(pageSignal), Reason.DomCallback);
                  }}
                >
                  {disconnecting ? "Disconnecting..." : "Disconnect"}
                </button>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
      <WhatsAppConnectDialog />
    </>
  );
}
