import type { FormEvent } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconArrowLeft,
  IconCircleCheck,
  IconLoader2,
  IconMessageCircle,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { Button } from "@vm0/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Input } from "@vm0/ui/components/ui/input";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  agentPhoneLinkStatus$,
  agentPhoneConnectDialogOpen$,
  agentPhonePhoneForm$,
  agentPhonePhoneFormError$,
  agentPhonePhoneFormNormalized$,
  agentPhoneShowPhoneError$,
  agentPhoneVerificationPhone$,
  disconnectAgentPhone$,
  resetAgentPhoneConnectUi$,
  setAgentPhoneConnectDialogOpen$,
  setAgentPhonePhoneForm$,
  setAgentPhoneShowPhoneError$,
  setAgentPhoneVerificationPhone$,
  startAgentPhoneLink$,
  waitForAgentPhoneConnection$,
} from "../../signals/zero-page/zero-agentphone.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import imessageIconImg from "./components/settings/icons/imessage.svg";

function AgentPhoneVerificationStatus({
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
          Verification text sent to {verificationPhone}. Open the link in that
          text to finish connecting.
        </span>
      </span>
    </div>
  );
}

function AgentPhoneConnectActions({
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

function AgentPhoneConnectDialog() {
  const open = useGet(agentPhoneConnectDialogOpen$);
  const phoneForm = useGet(agentPhonePhoneForm$);
  const normalizedPhone = useLastResolved(agentPhonePhoneFormNormalized$) ?? "";
  const phoneError = useLastResolved(agentPhonePhoneFormError$) ?? null;
  const verificationPhone =
    useLastResolved(agentPhoneVerificationPhone$) ?? null;
  const showPhoneError = useLastResolved(agentPhoneShowPhoneError$) ?? false;
  const setPhoneForm = useSet(setAgentPhonePhoneForm$);
  const setOpen = useSet(setAgentPhoneConnectDialogOpen$);
  const setVerificationPhone = useSet(setAgentPhoneVerificationPhone$);
  const setShowPhoneError = useSet(setAgentPhoneShowPhoneError$);
  const resetConnectUi = useSet(resetAgentPhoneConnectUi$);
  const pageSignal = useGet(pageSignal$);
  const [startLoadable, startLink] = useLoadableSet(startAgentPhoneLink$);
  const [connectLoadable, waitForConnection] = useLoadableSet(
    waitForAgentPhoneConnection$,
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
          <DialogTitle>Connect AgentPhone</DialogTitle>
          <DialogDescription>
            Enter your phone number. We will text a verification link that
            connects this workspace.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={submit}>
          <label
            htmlFor="agentphone-phone-input"
            className="text-sm font-medium text-foreground"
          >
            Phone number
          </label>
          <Input
            id="agentphone-phone-input"
            data-testid="agentphone-phone-input"
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
              data-testid="agentphone-normalized-phone"
            >
              We will text {normalizedPhone}.
            </p>
          ) : null}
          {visiblePhoneError ? (
            <p className="text-sm text-destructive" role="alert">
              {visiblePhoneError}
            </p>
          ) : null}
          <AgentPhoneVerificationStatus
            verificationPhone={verificationPhone}
            connecting={connecting}
          />
          <AgentPhoneConnectActions
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

function AgentPhoneSettingsCard() {
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
  const summary = status?.agentPhoneNumber
    ? `Text Zero at ${status.agentPhoneNumber}`
    : "Text-message access to Zero";

  return (
    <>
      <div className="zero-card overflow-hidden">
        <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:p-5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="shrink-0 inline-flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-background">
              <img src={imessageIconImg} alt="" className="h-8 w-8" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div className="truncate text-sm font-medium text-foreground">
                  AgentPhone
                </div>
                {isConnected ? (
                  <span
                    data-testid="agentphone-connected-indicator"
                    className="inline-flex min-w-0 max-w-52 items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground"
                  >
                    <IconCircleCheck className="h-3 w-3 text-green-600" />
                    <span
                      className="min-w-0 truncate"
                      title={connectedPhone ?? ""}
                    >
                      {connectedPhone
                        ? `Connected (${connectedPhone})`
                        : "Connected"}
                    </span>
                  </span>
                ) : null}
              </div>
              <div className="mt-1 truncate text-sm text-muted-foreground">
                {summary}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2">
            {status !== null && !isConnected ? (
              <Button
                type="button"
                className="gap-1.5"
                aria-label="Connect AgentPhone"
                onClick={() => {
                  setConnectOpen(true);
                }}
              >
                <IconMessageCircle size={14} stroke={1.5} />
                Connect
              </Button>
            ) : null}
            {isConnected ? (
              <Button
                type="button"
                variant="outline"
                disabled={disconnecting}
                aria-label="Disconnect AgentPhone"
                onClick={() => {
                  return detach(disconnect(pageSignal), Reason.DomCallback);
                }}
              >
                {disconnecting ? "Disconnecting..." : "Disconnect"}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      <AgentPhoneConnectDialog />
    </>
  );
}

export function ZeroAgentPhoneSettingsPage() {
  const features = useLastResolved(featureSwitch$);
  const enabled = features?.[FeatureSwitchKey.AgentPhoneAppUi];

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <Link
            pathname={ROUTES.works}
            className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <IconArrowLeft size={14} stroke={1.5} />
            Channels
          </Link>
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            AgentPhone
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Manage text-message access to Zero.
          </p>
        </div>
      </header>
      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-3 pb-8">
        <div className="mx-auto max-w-[900px]">
          {enabled === true ? (
            <AgentPhoneSettingsCard />
          ) : enabled === false ? (
            <div className="zero-card p-5 text-sm text-muted-foreground">
              AgentPhone is not enabled for this workspace.
            </div>
          ) : (
            <div className="zero-card p-5 text-sm text-muted-foreground">
              Loading AgentPhone...
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
