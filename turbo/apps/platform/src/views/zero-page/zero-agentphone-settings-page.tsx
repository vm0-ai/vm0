import type { FormEvent } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconLoader2,
  IconMessageCircle,
  IconTrash,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import type {
  AgentPhoneLinkStatusResponse,
  AgentPhoneStartLinkResponse,
} from "@vm0/api-contracts/contracts/zero-integrations-agentphone";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  agentPhoneLinkStatus$,
  agentPhonePhoneForm$,
  agentPhonePhoneFormError$,
  agentPhonePhoneFormNormalized$,
  disconnectAgentPhone$,
  setAgentPhonePhoneForm$,
  startAgentPhoneLink$,
} from "../../signals/zero-page/zero-agentphone.ts";
import { detach, Reason } from "../../signals/utils.ts";

function AgentPhoneIcon() {
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
      <IconMessageCircle size={22} stroke={1.8} />
    </span>
  );
}

function AgentPhoneStatusBadge({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium text-secondary-foreground">
        <IconCircleCheck className="h-3.5 w-3.5 text-green-600" />
        Connected
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
      <IconAlertTriangle className="h-3.5 w-3.5 text-amber-500" />
      Not connected
    </span>
  );
}

function AgentPhoneSettingsSkeleton() {
  return (
    <div className="zero-card p-5" data-testid="agentphone-settings-loading">
      <div className="flex items-center gap-4">
        <Skeleton className="h-10 w-10 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-56 max-w-full" />
        </div>
      </div>
    </div>
  );
}

function getAgentPhoneErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "AgentPhone request failed. Try again.";
}

function AgentPhoneDescription({
  status,
}: {
  status: AgentPhoneLinkStatusResponse;
}) {
  if (status.linked) {
    return (
      <p className="mt-1 text-sm text-muted-foreground">
        {status.phoneHandle} is connected to this workspace.
      </p>
    );
  }

  return (
    <p className="mt-1 text-sm text-muted-foreground">
      {status.configured
        ? "Enter your phone number and confirm the text link we send."
        : "AgentPhone is not configured for this environment."}
    </p>
  );
}

function AgentPhoneDisconnectButton({
  linked,
  disconnecting,
  onDisconnect,
}: {
  linked: boolean;
  disconnecting: boolean;
  onDisconnect: () => void;
}) {
  if (!linked) {
    return null;
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disconnecting}
      onClick={onDisconnect}
    >
      {disconnecting ? (
        <IconLoader2 size={14} className="animate-spin" />
      ) : (
        <IconTrash size={14} />
      )}
      {disconnecting ? "Disconnecting..." : "Disconnect"}
    </Button>
  );
}

function AgentPhoneLinkForm({
  status,
  phoneForm,
  normalizedPhone,
  phoneError,
  starting,
  verification,
  onPhoneChange,
  onSubmit,
}: {
  status: AgentPhoneLinkStatusResponse;
  phoneForm: string;
  normalizedPhone: string;
  phoneError: string | null;
  starting: boolean;
  verification: AgentPhoneStartLinkResponse | null;
  onPhoneChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (status.linked) {
    return null;
  }

  return (
    <form className="grid gap-3 sm:max-w-md" onSubmit={onSubmit}>
      <label
        htmlFor="agentphone-phone-input"
        className="text-sm font-medium text-foreground"
      >
        Phone number
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="agentphone-phone-input"
          data-testid="agentphone-phone-input"
          type="tel"
          inputMode="tel"
          placeholder="+1 555 555 1212"
          value={phoneForm}
          disabled={!status.configured || starting}
          onChange={(event) => {
            onPhoneChange(event.target.value);
          }}
        />
        <Button
          type="submit"
          disabled={
            !status.configured ||
            !normalizedPhone ||
            Boolean(phoneError) ||
            starting
          }
        >
          {starting ? <IconLoader2 size={14} className="animate-spin" /> : null}
          {starting ? "Sending..." : "Send verification"}
        </Button>
      </div>
      {normalizedPhone ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="agentphone-normalized-phone"
        >
          We will text {normalizedPhone}.
        </p>
      ) : null}
      {phoneError ? (
        <p className="text-sm text-destructive" role="alert">
          {phoneError}
        </p>
      ) : null}
      {verification ? (
        <div
          className="rounded-lg border border-green-600/20 bg-green-600/10 px-3 py-2 text-sm text-green-700 dark:text-green-300"
          role="status"
        >
          Verification text sent to {verification.phoneHandle}.
        </div>
      ) : null}
    </form>
  );
}

function AgentPhoneSettingsCard({
  status,
  phoneForm,
  normalizedPhone,
  phoneError,
  starting,
  disconnecting,
  verification,
  onPhoneChange,
  onSubmit,
  onDisconnect,
}: {
  status: AgentPhoneLinkStatusResponse;
  phoneForm: string;
  normalizedPhone: string;
  phoneError: string | null;
  starting: boolean;
  disconnecting: boolean;
  verification: AgentPhoneStartLinkResponse | null;
  onPhoneChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDisconnect: () => void;
}) {
  return (
    <section className="zero-card flex flex-col gap-5 p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <AgentPhoneIcon />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium text-foreground">
              Text messages
            </h2>
            <AgentPhoneStatusBadge connected={status.linked} />
          </div>
          <AgentPhoneDescription status={status} />
        </div>
        <AgentPhoneDisconnectButton
          linked={status.linked}
          disconnecting={disconnecting}
          onDisconnect={onDisconnect}
        />
      </div>

      <AgentPhoneLinkForm
        status={status}
        phoneForm={phoneForm}
        normalizedPhone={normalizedPhone}
        phoneError={phoneError}
        starting={starting}
        verification={verification}
        onPhoneChange={onPhoneChange}
        onSubmit={onSubmit}
      />

      {status.agentPhoneNumber ? (
        <p className="text-xs text-muted-foreground">
          Shared Zero number: {status.agentPhoneNumber}
        </p>
      ) : null}
    </section>
  );
}

function AgentPhoneRequestError({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }

  return (
    <div
      className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      role="alert"
    >
      {message}
    </div>
  );
}

export function ZeroAgentPhoneSettingsPage() {
  const statusLoadable = useLastLoadable(agentPhoneLinkStatus$);
  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const phoneForm = useGet(agentPhonePhoneForm$);
  const normalizedPhone = useLastResolved(agentPhonePhoneFormNormalized$) ?? "";
  const phoneError = useLastResolved(agentPhonePhoneFormError$) ?? null;
  const setPhoneForm = useSet(setAgentPhonePhoneForm$);
  const pageSignal = useGet(pageSignal$);
  const [startLoadable, startLink] = useLoadableSet(startAgentPhoneLink$);
  const [disconnectLoadable, disconnect] = useLoadableSet(
    disconnectAgentPhone$,
  );

  const starting = startLoadable.state === "loading";
  const disconnecting = disconnectLoadable.state === "loading";
  const startError =
    startLoadable.state === "hasError"
      ? getAgentPhoneErrorMessage(startLoadable.error)
      : null;
  const disconnectError =
    disconnectLoadable.state === "hasError"
      ? getAgentPhoneErrorMessage(disconnectLoadable.error)
      : null;
  const verification =
    startLoadable.state === "hasData" ? startLoadable.data : null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedPhone || phoneError || starting || status?.linked) {
      return;
    }
    detach(startLink(pageSignal), Reason.DomCallback);
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="hidden md:block shrink-0 bg-transparent px-4 pt-10 pb-3 sm:px-6">
        <div className="mx-auto max-w-[900px]">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            AgentPhone
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Connect a verified phone number for text-message access to Zero.
          </p>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 pt-3 pb-8 sm:px-6">
        <div className="mx-auto flex max-w-[900px] flex-col gap-4">
          {statusLoadable.state === "loading" && !status ? (
            <AgentPhoneSettingsSkeleton />
          ) : null}

          {status ? (
            <AgentPhoneSettingsCard
              status={status}
              phoneForm={phoneForm}
              normalizedPhone={normalizedPhone}
              phoneError={phoneError}
              starting={starting}
              disconnecting={disconnecting}
              verification={verification}
              onPhoneChange={setPhoneForm}
              onSubmit={submit}
              onDisconnect={() => {
                detach(disconnect(pageSignal), Reason.DomCallback);
              }}
            />
          ) : null}

          <AgentPhoneRequestError message={startError ?? disconnectError} />
        </div>
      </main>
    </div>
  );
}
