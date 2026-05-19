import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Button } from "@vm0/ui/components/ui/button";
import type { ConnectorType } from "@vm0/connectors/connectors";
import {
  getConnectorAuthMethod,
  getConnectorCliAuthFlow,
  getConnectorCliAuthModes,
} from "@vm0/connectors/connector-utils";
import type { MouseEventHandler, ReactElement } from "react";

import {
  connectorCliAuthState$,
  openConnectorCliAuthApprovalPage$,
  runConnectorCliAuth$,
  setConnectorCliAuthMode$,
  type ConnectorCliAuthState,
  type ConnectorTypeWithStatus,
} from "../../../../signals/zero-page/settings/connectors.ts";
import { onDomEventFn } from "../../../../signals/utils.ts";
import { ConnectorHelpText } from "./connector-help-text.tsx";

type CliAuthConnectMethodContentProps = {
  item: ConnectorTypeWithStatus;
  onSuccess: () => void | Promise<void>;
  showPermissionDialogOnConnect: boolean;
  signal: AbortSignal;
};

type CliAuthConnectMethodContentComponent = (
  props: CliAuthConnectMethodContentProps,
) => ReactElement;

type CliAuthModeOption = {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
};

type BrowserVerificationPendingState = Extract<
  ConnectorCliAuthState,
  { readonly status: "pending" | "polling" }
>;

function stateForConnector(
  state: ConnectorCliAuthState,
  type: ConnectorType,
): ConnectorCliAuthState {
  return state.connectorType === type
    ? state
    : { status: "idle", connectorType: type, mode: null };
}

function cliAuthModeOptions(type: ConnectorType): readonly CliAuthModeOption[] {
  return getConnectorCliAuthModes(type);
}

function CliAuthModePicker({
  mode,
  modeOptions,
  disabled,
  onSelectMode,
}: {
  mode: string | null;
  modeOptions: readonly CliAuthModeOption[];
  disabled: boolean;
  onSelectMode: (mode: string) => void;
}) {
  if (modeOptions.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-foreground">Mode</span>
      <div className="grid gap-2">
        {modeOptions.map((option) => {
          const selected = mode === option.value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => {
                return onSelectMode(option.value);
              }}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                selected
                  ? "border-primary bg-primary/5 text-foreground"
                  : "border-border/60 text-muted-foreground hover:text-foreground"
              }`}
            >
              <span className="block text-sm font-medium">{option.label}</span>
              {option.description && (
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {option.description}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BrowserVerificationPendingPanel({
  pendingState,
  onOpenApprovalPage,
}: {
  pendingState: BrowserVerificationPendingState;
  onOpenApprovalPage: MouseEventHandler<HTMLButtonElement>;
}) {
  const statusText = !pendingState.approvalOpened
    ? "Open the approval page to continue."
    : pendingState.status === "polling"
      ? "Checking connection..."
      : "Waiting for approval...";

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-border/60 px-3 py-2.5">
        <span className="text-xs text-muted-foreground">
          Confirm this pairing code matches the approval page
        </span>
        <span className="mt-1 block font-mono text-lg font-semibold text-foreground">
          {pendingState.verificationText}
        </span>
      </div>

      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={onOpenApprovalPage}
      >
        Open approval page
      </Button>

      <p className="text-sm text-muted-foreground">{statusText}</p>

      {pendingState.errorMessage && (
        <p className="text-sm text-amber-600">{pendingState.errorMessage}</p>
      )}
    </div>
  );
}

function cliAuthErrorText(state: ConnectorCliAuthState): string | null {
  switch (state.status) {
    case "error":
    case "expired": {
      return state.message;
    }
    default: {
      return null;
    }
  }
}

function BrowserVerificationCliAuthConnectMethodContent({
  item,
  onSuccess,
  showPermissionDialogOnConnect,
  signal,
}: CliAuthConnectMethodContentProps) {
  const type = item.type;
  const cliAuthConfig = getConnectorAuthMethod(type, "cli-auth");
  const rawState = useGet(connectorCliAuthState$);
  const cliAuthState = stateForConnector(rawState, type);
  const setMode = useSet(setConnectorCliAuthMode$);
  const openApprovalPage = useSet(openConnectorCliAuthApprovalPage$);
  const [runLoadable, runCliAuth] = useLoadableSet(runConnectorCliAuth$);
  const modeOptions = cliAuthModeOptions(type);
  const inFlight =
    cliAuthState.status === "starting" ||
    cliAuthState.status === "pending" ||
    cliAuthState.status === "polling" ||
    runLoadable.state === "loading";
  const pendingState =
    cliAuthState.status === "pending" || cliAuthState.status === "polling"
      ? cliAuthState
      : null;
  const requiresMode = modeOptions.length > 0;
  const canStart = !inFlight && (!requiresMode || !!cliAuthState.mode);
  const errorText = cliAuthErrorText(cliAuthState);

  if (!cliAuthConfig) {
    return (
      <p className="text-sm text-muted-foreground">
        This connection method is not configured for this connector.
      </p>
    );
  }

  const handleStart = onDomEventFn(async () => {
    if (!canStart) {
      return;
    }
    const completed = await runCliAuth(
      type,
      { showPermissionDialog: showPermissionDialogOnConnect },
      signal,
    );
    if (completed) {
      await onSuccess();
    }
  });

  const handleOpenApprovalPage = onDomEventFn(() => {
    openApprovalPage(type);
  });

  return (
    <div className="flex flex-col gap-3">
      {cliAuthConfig.helpText && (
        <ConnectorHelpText text={cliAuthConfig.helpText} />
      )}

      {!pendingState && (
        <>
          <CliAuthModePicker
            mode={cliAuthState.mode}
            modeOptions={modeOptions}
            disabled={inFlight}
            onSelectMode={(mode) => {
              return setMode(type, mode);
            }}
          />

          {errorText && <p className="text-sm text-destructive">{errorText}</p>}

          <Button
            type="button"
            onClick={handleStart}
            disabled={!canStart}
            className="w-full"
          >
            {cliAuthState.status === "starting" ||
            runLoadable.state === "loading"
              ? "Starting..."
              : requiresMode && !cliAuthState.mode
                ? "Select a mode to continue"
                : cliAuthConfig.label}
          </Button>
        </>
      )}

      {pendingState && (
        <BrowserVerificationPendingPanel
          pendingState={pendingState}
          onOpenApprovalPage={handleOpenApprovalPage}
        />
      )}
    </div>
  );
}

export function getCliAuthConnectMethodContentComponent(
  type: ConnectorType,
): CliAuthConnectMethodContentComponent | null {
  switch (getConnectorCliAuthFlow(type)) {
    case "browser-verification": {
      return BrowserVerificationCliAuthConnectMethodContent;
    }
    default: {
      return null;
    }
  }
}
