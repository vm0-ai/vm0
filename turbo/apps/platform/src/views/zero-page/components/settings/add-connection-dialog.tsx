import { useLastResolved, useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Input } from "@vm0/ui/components/ui/input";
import { Button } from "@vm0/ui/components/ui/button";
import { CopyButton } from "@vm0/ui/components/ui/copy-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import {
  CONNECTOR_TYPES,
  type ConnectorAuthMethodConfig,
  type ConnectorAuthMethodId,
  type ConnectorDeviceAuthStartOptions,
  type ConnectorDeviceAuthStartOptionsConfig,
  type ConnectorManualGrantConfig,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import type { ReactElement } from "react";
import { getConnectorAuthMethod } from "@vm0/connectors/connector-utils";
import {
  allConnectorTypes$,
  connectFlowType$,
  pollingOAuthAuthCodeConnectorType$,
  connectorExternalCodeState$,
  connectorOAuthDeviceAuthState$,
  connectConnectorOAuthAuthCodeAndSettle$,
  connectConnectorOAuthDeviceAuthAndSettle$,
  connectConnectorExternalCode$,
  completeConnectorExternalCodeAndSettle$,
  openConnectorExternalCodeAuthorizationPage$,
  openConnectorOAuthDeviceAuthVerificationPage$,
  clearConnectorExternalCode$,
  clearConnectorOAuthDeviceAuth$,
  connectorOAuthDeviceAuthStartOptionValuesFor$,
  setConnectorOAuthDeviceAuthStartOptionValue$,
  setConnectorExternalCodeAuthorizationCode$,
  runConnectorConnectSuccess$,
  submitManualGrant$,
  setManualGrantFormValue$,
  clearManualGrantForm$,
  manualGrantFormValuesFor$,
  selectedConnectorType$,
  isStandaloneMode,
  connectorCurrentConnectionStatus,
  connectorExpiryCountdownText,
  type ConnectorExternalCodeState,
  type ConnectorOAuthDeviceAuthState,
  type ConnectorTypeWithStatus,
} from "../../../../signals/zero-page/settings/connectors.ts";
import { hasTokenInputValue } from "../../../../signals/zero-page/settings/token-input.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { ConnectorIcon } from "./connector-icons.tsx";
import { detach, onDomEventFn, Reason } from "../../../../signals/utils.ts";
import { shouldShowGoogleSecurityWarningNotice } from "../../../../lib/google-security-warning.ts";
import { GoogleSecurityWarningNotice } from "../../zero-directed-shared.tsx";
import { ConnectorHelpText } from "./connector-help-text.tsx";

// ---------------------------------------------------------------------------
// Connected status text helper
// ---------------------------------------------------------------------------

function connectedStatusText(item: ConnectorTypeWithStatus): string {
  const connectionStatus = connectorCurrentConnectionStatus(item);
  if (connectionStatus === "reconnect-required") {
    return "Connection expired";
  }
  if (connectionStatus === "scope-mismatch") {
    return "Permissions update available";
  }
  const expiryText = connectorExpiryCountdownText(item);
  if (expiryText) {
    return expiryText;
  }
  if (item.connector?.externalUsername) {
    if (item.connector.externalUsername.startsWith("arn:")) {
      return `Connected as ${item.connector.externalUsername}`;
    }
    return `Connected as @${item.connector.externalUsername}`;
  }
  return "Connected";
}

type PostConnectOptions = {
  readonly showPermissionDialog?: boolean;
};

type SubmitManualGrantFn = (
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
  inputValues: Record<string, string>,
  options: PostConnectOptions,
  signal: AbortSignal,
) => Promise<void>;

type ConnectOAuthAuthCodeAndSettleFn = (
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
  onSuccess: () => void | Promise<void>,
  options: PostConnectOptions,
  signal: AbortSignal,
) => Promise<void>;

type ConnectOAuthDeviceAuthAndSettleFn = (
  args: {
    readonly type: ConnectorType;
    readonly authMethod: ConnectorAuthMethodId;
    readonly onSuccess: () => void | Promise<void>;
    readonly options: PostConnectOptions;
    readonly startOptions?: ConnectorDeviceAuthStartOptions;
  },
  signal: AbortSignal,
) => Promise<void>;

type ConnectExternalCodeFn = (
  args: {
    readonly type: ConnectorType;
    readonly authMethod: ConnectorAuthMethodId;
  },
  signal: AbortSignal,
) => Promise<void>;

type CompleteExternalCodeAndSettleFn = (
  args: {
    readonly type: ConnectorType;
    readonly authMethod: ConnectorAuthMethodId;
    readonly onSuccess: () => void | Promise<void>;
    readonly options: PostConnectOptions;
  },
  signal: AbortSignal,
) => Promise<void>;

type ConnectModalContentProps = {
  item: ConnectorTypeWithStatus;
  onSuccess: () => void | Promise<void>;
  showPermissionDialogOnConnect: boolean;
};

type ConnectMethodContentProps = ConnectModalContentProps & {
  authMethod: ConnectorAuthMethodId;
  method: ConnectorAuthMethodConfig;
  connectOAuthAuthCodeAndSettle: ConnectOAuthAuthCodeAndSettleFn;
  connectOAuthDeviceAuthAndSettle: ConnectOAuthDeviceAuthAndSettleFn;
  connectExternalCode: ConnectExternalCodeFn;
  completeExternalCodeAndSettle: CompleteExternalCodeAndSettleFn;
  submitManualGrant: SubmitManualGrantFn;
  manualGrantSubmitting: boolean;
  signal: AbortSignal;
};

type ConnectMethodSharedContentProps = Omit<
  ConnectMethodContentProps,
  "authMethod" | "method"
>;

type ConnectMethodContentComponent = (
  props: ConnectMethodContentProps,
) => ReactElement | null;

type ConnectMethodContentEntry = {
  authMethod: ConnectorAuthMethodId;
  method: ConnectorAuthMethodConfig;
  Content: ConnectMethodContentComponent;
};

function connectorOAuthDeviceAuthFlowIsActive(
  state: ConnectorOAuthDeviceAuthState,
  type: ConnectorType,
): boolean {
  return (
    state.connectorType === type &&
    (state.status === "starting" ||
      state.status === "pending" ||
      state.status === "polling")
  );
}

function connectorExternalCodeFlowIsActive(
  state: ConnectorExternalCodeState,
  type: ConnectorType,
): boolean {
  return (
    state.connectorType === type &&
    (state.status === "starting" ||
      state.status === "pending" ||
      state.status === "completing")
  );
}

function connectorOAuthDeviceAuthStateForMethod(
  state: ConnectorOAuthDeviceAuthState,
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
): ConnectorOAuthDeviceAuthState | null {
  if (state.connectorType !== type || state.status === "idle") {
    return null;
  }
  return state.authMethod === authMethod ? state : null;
}

function connectorExternalCodeStateForMethod(
  state: ConnectorExternalCodeState,
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
): ConnectorExternalCodeState | null {
  if (state.connectorType !== type || state.status === "idle") {
    return null;
  }
  return state.authMethod === authMethod ? state : null;
}

// ---------------------------------------------------------------------------
// Manual grant form (shown inside connect modal)
// ---------------------------------------------------------------------------

function ManualGrantForm({
  type,
  authMethod,
  method,
  grant,
  onSuccess,
  showPermissionDialogOnConnect,
  submit,
  submitting,
}: {
  type: ConnectorType;
  authMethod: ConnectorAuthMethodId;
  method: ConnectorAuthMethodConfig;
  grant: ConnectorManualGrantConfig;
  onSuccess: () => void | Promise<void>;
  showPermissionDialogOnConnect: boolean;
  submit: SubmitManualGrantFn;
  submitting: boolean;
}) {
  const setFormValue = useSet(setManualGrantFormValue$);
  const clearForm = useSet(clearManualGrantForm$);
  const pageSignal = useGet(pageSignal$);
  const fieldValues = useGet(manualGrantFormValuesFor$(type));

  const fieldEntries = Object.entries(grant.fields);
  const allFilled = fieldEntries.every(([name, cfg]) => {
    return !cfg.required || hasTokenInputValue(fieldValues[name]);
  });

  const handleSubmit = onDomEventFn(async () => {
    if (!allFilled || submitting) {
      return;
    }
    await submit(
      type,
      authMethod,
      fieldValues,
      {
        showPermissionDialog: showPermissionDialogOnConnect,
      },
      pageSignal,
    );
    clearForm(type);
    await onSuccess();
  });

  return (
    <div className="flex flex-col gap-3">
      {method.helpText && <ConnectorHelpText text={method.helpText} />}
      {fieldEntries.map(([name, fieldConfig]) => {
        return (
          <div key={name} className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">
              {fieldConfig.label}
            </label>
            <Input
              type="password"
              placeholder={fieldConfig.placeholder}
              value={fieldValues[name] ?? ""}
              onChange={(e) => {
                return setFormValue(type, name, e.target.value);
              }}
            />
          </div>
        );
      })}
      <Button
        onClick={handleSubmit}
        disabled={!allFilled || submitting}
        className="w-full"
      >
        {submitting ? "Saving..." : "Save"}
      </Button>
    </div>
  );
}

function UnavailableConnectMethodsContent() {
  return (
    <div className="rounded-md border border-dashed border-border bg-muted/30 p-3">
      <p className="text-sm font-medium text-foreground">
        Connection methods unavailable
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        This connector has available connection methods, but none of them can be
        configured from this dialog yet.
      </p>
    </div>
  );
}

function getOAuthAuthCodeProgressContent({
  isPolling,
  settling,
}: {
  isPolling: boolean;
  settling: boolean;
}) {
  // While auth-code OAuth is in progress, only show connecting state
  if (isPolling) {
    const standaloneHint = isStandaloneMode()
      ? " Switch back here after completing sign-in."
      : "";
    return (
      <p className="text-sm text-muted-foreground">{`Connecting...${standaloneHint}`}</p>
    );
  }

  if (settling) {
    return (
      <p className="text-sm text-muted-foreground">Saving permissions...</p>
    );
  }

  return null;
}

function OAuthAuthCodeConnectButton({
  item,
  authMethod,
  onSuccess,
  showPermissionDialogOnConnect,
  connectOAuthAuthCodeAndSettle,
  signal,
}: ConnectModalContentProps & {
  authMethod: ConnectorAuthMethodId;
  connectOAuthAuthCodeAndSettle: ConnectOAuthAuthCodeAndSettleFn;
  signal: AbortSignal;
}) {
  return (
    <Button
      variant="outline"
      onClick={() => {
        return detach(
          connectOAuthAuthCodeAndSettle(
            item.type,
            authMethod,
            onSuccess,
            {
              showPermissionDialog: showPermissionDialogOnConnect,
            },
            signal,
          ),
          Reason.DomCallback,
        );
      }}
      className="w-full"
    >
      {item.connected ? "Authorize" : "Connect"}
    </Button>
  );
}

function OAuthAuthCodeConnectMethodContent(props: ConnectMethodContentProps) {
  return (
    <OAuthAuthCodeConnectButton
      item={props.item}
      authMethod={props.authMethod}
      onSuccess={props.onSuccess}
      showPermissionDialogOnConnect={props.showPermissionDialogOnConnect}
      connectOAuthAuthCodeAndSettle={props.connectOAuthAuthCodeAndSettle}
      signal={props.signal}
    />
  );
}

function getOAuthDeviceAuthStatusText(
  state: Extract<
    ConnectorOAuthDeviceAuthState,
    { readonly status: "pending" | "polling" }
  >,
): string {
  if (!state.approvalOpened) {
    return "Copy this code, then open the verification page to approve access.";
  }
  if (state.status === "polling") {
    return "Checking for approval...";
  }
  return "Waiting for approval. Keep this dialog open.";
}

function OAuthDeviceAuthCodePanel({
  state,
  onOpenVerificationPage,
}: {
  state: Extract<
    ConnectorOAuthDeviceAuthState,
    { readonly status: "pending" | "polling" }
  >;
  onOpenVerificationPage: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Open the provider&apos;s verification page, then enter this verification
        code to approve access.
      </p>
      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Verification code</p>
            <p
              className="mt-1 break-all font-mono text-2xl font-semibold tracking-normal"
              data-testid="connector-oauth-device-code"
            >
              {state.userCode}
            </p>
          </div>
          <CopyButton
            type="button"
            text={state.userCode}
            className="-m-1 p-1.5 hover:bg-accent"
          />
        </div>
      </div>
      {state.errorMessage && (
        <p className="text-xs text-destructive" role="alert">
          {state.errorMessage}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={onOpenVerificationPage}
        data-testid="connector-oauth-device-open"
      >
        Open verification page
      </Button>
      <p className="text-xs text-muted-foreground" role="status">
        {getOAuthDeviceAuthStatusText(state)}
      </p>
    </div>
  );
}

function defaultDeviceAuthStartOptionValues(
  startOptions: ConnectorDeviceAuthStartOptionsConfig | undefined,
): Record<string, string> {
  if (!startOptions) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(startOptions).flatMap(([name, config]) => {
      return config.defaultValue === undefined
        ? []
        : ([[name, config.defaultValue]] as const);
    }),
  );
}

function deviceAuthStartOptionValue(
  values: Record<string, string>,
  name: string,
): string | undefined {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

function selectedDeviceAuthStartOptions(
  startOptions: ConnectorDeviceAuthStartOptionsConfig | undefined,
  values: Record<string, string>,
): ConnectorDeviceAuthStartOptions | undefined {
  if (!startOptions) {
    return undefined;
  }
  const selectedEntries = Object.entries(startOptions).flatMap(
    ([name, config]) => {
      const value =
        deviceAuthStartOptionValue(values, name) ?? config.defaultValue;
      return value === undefined ? [] : ([[name, value]] as const);
    },
  );
  return selectedEntries.length === 0
    ? undefined
    : Object.fromEntries(selectedEntries);
}

function deviceAuthStartOptionsFilled(
  startOptions: ConnectorDeviceAuthStartOptionsConfig | undefined,
  values: Record<string, string>,
): boolean {
  if (!startOptions) {
    return true;
  }
  return Object.entries(startOptions).every(([name, config]) => {
    return (
      !config.required ||
      Boolean(deviceAuthStartOptionValue(values, name) ?? config.defaultValue)
    );
  });
}

function OAuthDeviceAuthStartOptionsForm({
  type,
  authMethod,
  startOptions,
  values,
  setValue,
}: {
  type: ConnectorType;
  authMethod: ConnectorAuthMethodId;
  startOptions: ConnectorDeviceAuthStartOptionsConfig | undefined;
  values: Record<string, string>;
  setValue: (name: string, value: string) => void;
}) {
  if (!startOptions) {
    return null;
  }

  return (
    <>
      {Object.entries(startOptions).map(([name, config]) => {
        const inputId = `connector-device-auth-option-${type}-${authMethod}-${name}`;
        return (
          <div key={name} className="flex flex-col gap-1.5">
            <label
              htmlFor={inputId}
              className="text-sm font-medium text-foreground"
            >
              {config.label}
            </label>
            <Select
              value={
                deviceAuthStartOptionValue(values, name) ?? config.defaultValue
              }
              onValueChange={(value) => {
                setValue(name, value);
              }}
            >
              <SelectTrigger id={inputId} className="h-9">
                <SelectValue placeholder={`Select ${config.label}`} />
              </SelectTrigger>
              <SelectContent>
                {config.options.map((option) => {
                  return (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        );
      })}
    </>
  );
}

function OAuthDeviceAuthConnectMethodContent(props: ConnectMethodContentProps) {
  const state = useGet(connectorOAuthDeviceAuthState$);
  const openVerificationPage = useSet(
    openConnectorOAuthDeviceAuthVerificationPage$,
  );
  const setStartOptionValueCommand = useSet(
    setConnectorOAuthDeviceAuthStartOptionValue$,
  );
  const startOptions =
    props.method.grant.kind === "device-auth"
      ? props.method.grant.startOptions
      : undefined;
  const startOptionValues = useGet(
    connectorOAuthDeviceAuthStartOptionValuesFor$(
      props.item.type,
      props.authMethod,
    ),
  );
  const effectiveStartOptionValues = {
    ...defaultDeviceAuthStartOptionValues(startOptions),
    ...startOptionValues,
  };
  const startOptionsFilled = deviceAuthStartOptionsFilled(
    startOptions,
    effectiveStartOptionValues,
  );
  const setStartOptionValue = (name: string, value: string) => {
    setStartOptionValueCommand({
      type: props.item.type,
      authMethod: props.authMethod,
      name,
      value,
    });
  };
  const current = connectorOAuthDeviceAuthStateForMethod(
    state,
    props.item.type,
    props.authMethod,
  );
  const starting = current?.status === "starting";

  const start = onDomEventFn(async () => {
    await props.connectOAuthDeviceAuthAndSettle(
      {
        type: props.item.type,
        authMethod: props.authMethod,
        onSuccess: props.onSuccess,
        options: {
          showPermissionDialog: props.showPermissionDialogOnConnect,
        },
        startOptions: selectedDeviceAuthStartOptions(
          startOptions,
          effectiveStartOptionValues,
        ),
      },
      props.signal,
    );
  });

  if (current?.status === "starting") {
    return (
      <p className="text-sm text-muted-foreground">Starting connection...</p>
    );
  }

  if (current?.status === "pending" || current?.status === "polling") {
    return (
      <OAuthDeviceAuthCodePanel
        state={current}
        onOpenVerificationPage={() => {
          openVerificationPage(props.item.type, props.authMethod);
        }}
      />
    );
  }

  if (
    current?.status === "denied" ||
    current?.status === "expired" ||
    current?.status === "error"
  ) {
    return (
      <div className="flex flex-col gap-3">
        <OAuthDeviceAuthStartOptionsForm
          type={props.item.type}
          authMethod={props.authMethod}
          startOptions={startOptions}
          values={effectiveStartOptionValues}
          setValue={setStartOptionValue}
        />
        <p className="text-sm text-destructive" role="alert">
          {current.message}
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={start}
          disabled={starting || !startOptionsFilled}
          className="w-full"
        >
          {starting ? "Starting..." : "Try again"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Connect to get a verification code, then use it on the provider&apos;s
        verification page to approve access.
      </p>
      <OAuthDeviceAuthStartOptionsForm
        type={props.item.type}
        authMethod={props.authMethod}
        startOptions={startOptions}
        values={effectiveStartOptionValues}
        setValue={setStartOptionValue}
      />
      <Button
        type="button"
        variant="outline"
        onClick={start}
        disabled={starting || !startOptionsFilled}
        className="w-full"
      >
        {starting
          ? "Starting..."
          : `Connect ${CONNECTOR_TYPES[props.item.type].label}`}
      </Button>
    </div>
  );
}

type PendingConnectorExternalCodeState = Extract<
  ConnectorExternalCodeState,
  { readonly status: "pending" | "completing" }
>;
type ExternalCodeButtonHandler = (event: unknown) => void;

function ExternalCodeStartContent({
  type,
  method,
  current,
  starting,
  onStart,
}: {
  type: ConnectorType;
  method: ConnectorAuthMethodConfig;
  current: ConnectorExternalCodeState | null;
  starting: boolean;
  onStart: ExternalCodeButtonHandler;
}) {
  const terminalMessage =
    current?.status === "expired" || current?.status === "error"
      ? current.message
      : null;
  return (
    <div className="flex flex-col gap-3">
      {method.helpText && <ConnectorHelpText text={method.helpText} />}
      {terminalMessage ? (
        <p className="text-sm text-destructive" role="alert">
          {terminalMessage}
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        onClick={onStart}
        disabled={starting}
        className="w-full"
      >
        {starting
          ? "Starting..."
          : `Start ${CONNECTOR_TYPES[type].label} sign-in`}
      </Button>
    </div>
  );
}

function ExternalCodePendingContent({
  type,
  method,
  current,
  onOpen,
  onCodeChange,
  onComplete,
}: {
  type: ConnectorType;
  method: ConnectorAuthMethodConfig;
  current: PendingConnectorExternalCodeState;
  onOpen: ExternalCodeButtonHandler;
  onCodeChange: (code: string) => void;
  onComplete: ExternalCodeButtonHandler;
}) {
  const completing = current.status === "completing";
  const connectorLabel = CONNECTOR_TYPES[type].label;
  return (
    <div className="flex flex-col gap-3">
      {method.helpText && <ConnectorHelpText text={method.helpText} />}
      <p className="text-sm text-muted-foreground">
        Open {connectorLabel} sign-in, then paste the authorization code
        displayed by {connectorLabel}.
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-w-0 flex-1"
          onClick={onOpen}
        >
          Open {connectorLabel} sign-in
        </Button>
        <CopyButton
          type="button"
          text={current.authorizationUrl}
          className="p-2 hover:bg-accent"
        />
      </div>
      <Input
        value={current.code}
        onChange={(event) => {
          onCodeChange(event.target.value);
        }}
        placeholder="Authorization code"
        autoComplete="one-time-code"
        data-testid="connector-external-code-input"
      />
      {current.errorMessage && (
        <p className="text-xs text-destructive" role="alert">
          {current.errorMessage}
        </p>
      )}
      <Button
        type="button"
        onClick={onComplete}
        disabled={completing || current.code.trim().length === 0}
        className="w-full"
        data-testid="connector-external-code-complete"
      >
        {completing ? "Connecting..." : "Complete connection"}
      </Button>
    </div>
  );
}

function ExternalCodeConnectMethodContent(props: ConnectMethodContentProps) {
  const state = useGet(connectorExternalCodeState$);
  const setCode = useSet(setConnectorExternalCodeAuthorizationCode$);
  const openAuthorizationPage = useSet(
    openConnectorExternalCodeAuthorizationPage$,
  );
  const current = connectorExternalCodeStateForMethod(
    state,
    props.item.type,
    props.authMethod,
  );
  const starting = current?.status === "starting";

  const start = onDomEventFn(async () => {
    await props.connectExternalCode(
      {
        type: props.item.type,
        authMethod: props.authMethod,
      },
      props.signal,
    );
  });

  const complete = onDomEventFn(async () => {
    await props.completeExternalCodeAndSettle(
      {
        type: props.item.type,
        authMethod: props.authMethod,
        onSuccess: props.onSuccess,
        options: {
          showPermissionDialog: props.showPermissionDialogOnConnect,
        },
      },
      props.signal,
    );
  });

  if (starting) {
    return (
      <p className="text-sm text-muted-foreground">Starting connection...</p>
    );
  }

  if (current?.status === "pending" || current?.status === "completing") {
    return (
      <ExternalCodePendingContent
        type={props.item.type}
        method={props.method}
        current={current}
        onOpen={() => {
          openAuthorizationPage(props.item.type, props.authMethod);
        }}
        onCodeChange={(code) => {
          setCode({
            type: props.item.type,
            authMethod: props.authMethod,
            code,
          });
        }}
        onComplete={complete}
      />
    );
  }

  return (
    <ExternalCodeStartContent
      type={props.item.type}
      method={props.method}
      current={current}
      starting={starting}
      onStart={start}
    />
  );
}

function ManualGrantConnectMethodContent(props: ConnectMethodContentProps) {
  if (props.method.grant.kind !== "manual") {
    return null;
  }
  return (
    <ManualGrantForm
      type={props.item.type}
      authMethod={props.authMethod}
      method={props.method}
      grant={props.method.grant}
      onSuccess={props.onSuccess}
      showPermissionDialogOnConnect={props.showPermissionDialogOnConnect}
      submit={props.submitManualGrant}
      submitting={props.manualGrantSubmitting}
    />
  );
}

function getConnectMethodContentComponent(
  method: ConnectorAuthMethodConfig,
): ConnectMethodContentComponent | null {
  switch (method.grant.kind) {
    case "auth-code": {
      return OAuthAuthCodeConnectMethodContent;
    }
    case "device-auth": {
      return OAuthDeviceAuthConnectMethodContent;
    }
    case "external-code": {
      return ExternalCodeConnectMethodContent;
    }
    case "manual": {
      return ManualGrantConnectMethodContent;
    }
    case "managed": {
      return null;
    }
  }
}

function getConnectMethodContentEntries(
  item: ConnectorTypeWithStatus,
): ConnectMethodContentEntry[] {
  return item.availableAuthMethods.flatMap((authMethod) => {
    const method = getConnectorAuthMethod(item.type, authMethod);
    if (!method) {
      return [];
    }
    const Content = getConnectMethodContentComponent(method);
    return Content ? [{ authMethod, method, Content }] : [];
  });
}

function hasAuthCodeGrant(
  type: ConnectorType,
  authMethods: readonly ConnectorAuthMethodId[],
): boolean {
  return authMethods.some((authMethod) => {
    return getConnectorAuthMethod(type, authMethod)?.grant.kind === "auth-code";
  });
}

function AuthMethodDivider() {
  return (
    <div className="relative py-1">
      <div className="absolute inset-0 flex items-center">
        <span className="w-full zero-border-t" />
      </div>
      <div className="relative flex justify-center text-xs">
        <span className="bg-background px-2 text-muted-foreground">or</span>
      </div>
    </div>
  );
}

function ConnectMethodHeading({
  method,
  show,
}: {
  method: ConnectorAuthMethodConfig;
  show: boolean;
}) {
  if (!show) {
    return null;
  }

  return (
    <h3 className="text-sm font-medium text-foreground">{method.label}</h3>
  );
}

function ConnectMethodsContent({
  entries,
  availableAuthMethodCount,
  props,
}: {
  entries: readonly ConnectMethodContentEntry[];
  availableAuthMethodCount: number;
  props: ConnectMethodSharedContentProps;
}) {
  if (availableAuthMethodCount === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No connection method is available.
      </p>
    );
  }

  if (entries.length === 0) {
    return <UnavailableConnectMethodsContent />;
  }

  const showMethodHeadings = entries.length > 1;
  return (
    <>
      {entries.map(({ authMethod, method, Content }, index) => {
        return (
          <div
            key={`${props.item.type}:${authMethod}`}
            className="flex flex-col gap-3"
          >
            {index > 0 && <AuthMethodDivider />}
            <ConnectMethodHeading method={method} show={showMethodHeadings} />
            <Content {...props} authMethod={authMethod} method={method} />
          </div>
        );
      })}
    </>
  );
}

function StandardConnectMethodsContent({
  item,
  onSuccess,
  showPermissionDialogOnConnect,
  connectOAuthAuthCodeAndSettle,
  connectOAuthDeviceAuthAndSettle,
  connectExternalCode,
  completeExternalCodeAndSettle,
  submitManualGrant,
  manualGrantSubmitting,
  signal,
  entries,
}: ConnectModalContentProps & {
  connectOAuthAuthCodeAndSettle: ConnectOAuthAuthCodeAndSettleFn;
  connectOAuthDeviceAuthAndSettle: ConnectOAuthDeviceAuthAndSettleFn;
  connectExternalCode: ConnectExternalCodeFn;
  completeExternalCodeAndSettle: CompleteExternalCodeAndSettleFn;
  submitManualGrant: SubmitManualGrantFn;
  manualGrantSubmitting: boolean;
  signal: AbortSignal;
  entries: readonly ConnectMethodContentEntry[];
}) {
  const showGoogleSecurityWarningNotice =
    hasAuthCodeGrant(
      item.type,
      entries.map((entry) => {
        return entry.authMethod;
      }),
    ) && shouldShowGoogleSecurityWarningNotice(item.type);

  return (
    <div className="flex flex-col gap-4">
      {showGoogleSecurityWarningNotice && <GoogleSecurityWarningNotice />}

      <ConnectMethodsContent
        entries={entries}
        availableAuthMethodCount={item.availableAuthMethods.length}
        props={{
          item,
          onSuccess,
          showPermissionDialogOnConnect,
          connectOAuthAuthCodeAndSettle,
          connectOAuthDeviceAuthAndSettle,
          connectExternalCode,
          completeExternalCodeAndSettle,
          submitManualGrant,
          manualGrantSubmitting,
          signal,
        }}
      />
    </div>
  );
}

function ConnectModalContent({
  item,
  onSuccess,
  showPermissionDialogOnConnect,
}: ConnectModalContentProps) {
  const [settleLoadable, connectOAuthAuthCodeAndSettleCommand] = useLoadableSet(
    connectConnectorOAuthAuthCodeAndSettle$,
  );
  const [, connectOAuthDeviceAuthAndSettle] = useLoadableSet(
    connectConnectorOAuthDeviceAuthAndSettle$,
  );
  const [, connectExternalCodeCommand] = useLoadableSet(
    connectConnectorExternalCode$,
  );
  const [, completeExternalCodeAndSettleCommand] = useLoadableSet(
    completeConnectorExternalCodeAndSettle$,
  );
  const [manualGrantLoadable, submitManualGrantCommand] =
    useLoadableSet(submitManualGrant$);
  const submitManualGrant: SubmitManualGrantFn = async (
    type,
    authMethod,
    inputValues,
    options,
    signal,
  ) => {
    await submitManualGrantCommand(
      { type, authMethod, inputValues, options },
      signal,
    );
  };
  const [, runConnectSuccess] = useLoadableSet(runConnectorConnectSuccess$);
  const pageSignal = useGet(pageSignal$);
  const pollingType = useGet(pollingOAuthAuthCodeConnectorType$);
  const settling = settleLoadable.state === "loading";
  const manualGrantSubmitting = manualGrantLoadable.state === "loading";
  const isPolling = pollingType === item.type;
  const entries = getConnectMethodContentEntries(item);
  const onConnectSuccess = async () => {
    await runConnectSuccess(item.type, onSuccess, pageSignal);
  };
  const connectOAuthAuthCodeAndSettle: ConnectOAuthAuthCodeAndSettleFn = async (
    type,
    authMethod,
    connectSuccess,
    options,
    signal,
  ) => {
    await connectOAuthAuthCodeAndSettleCommand(
      { type, authMethod, onSuccess: connectSuccess, options },
      signal,
    );
  };
  const connectOAuthDeviceAuthAndSettleCommandFn: ConnectOAuthDeviceAuthAndSettleFn =
    async (args, signal) => {
      await connectOAuthDeviceAuthAndSettle(
        {
          type: args.type,
          authMethod: args.authMethod,
          onSuccess: args.onSuccess,
          options: args.options,
          startOptions: args.startOptions,
        },
        signal,
      );
    };
  const connectExternalCode: ConnectExternalCodeFn = async (args, signal) => {
    await connectExternalCodeCommand(args, signal);
  };
  const completeExternalCodeAndSettle: CompleteExternalCodeAndSettleFn = async (
    args,
    signal,
  ) => {
    await completeExternalCodeAndSettleCommand(args, signal);
  };

  const progressContent = hasAuthCodeGrant(item.type, item.availableAuthMethods)
    ? getOAuthAuthCodeProgressContent({
        isPolling,
        settling,
      })
    : null;
  if (progressContent) {
    return progressContent;
  }

  return (
    <StandardConnectMethodsContent
      item={item}
      onSuccess={onConnectSuccess}
      showPermissionDialogOnConnect={showPermissionDialogOnConnect}
      connectOAuthAuthCodeAndSettle={connectOAuthAuthCodeAndSettle}
      connectOAuthDeviceAuthAndSettle={connectOAuthDeviceAuthAndSettleCommandFn}
      connectExternalCode={connectExternalCode}
      completeExternalCodeAndSettle={completeExternalCodeAndSettle}
      submitManualGrant={submitManualGrant}
      manualGrantSubmitting={manualGrantSubmitting}
      signal={pageSignal}
      entries={entries}
    />
  );
}

// ---------------------------------------------------------------------------
// Connect modal opened when configuring a connector.
// ---------------------------------------------------------------------------

export function ConnectModal({
  onClose,
  onSuccess,
  showPermissionDialogOnConnect = false,
}: {
  onClose: () => void;
  onSuccess?: () => void | Promise<void>;
  showPermissionDialogOnConnect?: boolean;
}) {
  const selectedType = useGet(selectedConnectorType$);
  const connectorTypes = useLastResolved(allConnectorTypes$);
  const clearConnectorOAuthDeviceAuth = useSet(clearConnectorOAuthDeviceAuth$);
  const clearConnectorExternalCode = useSet(clearConnectorExternalCode$);
  const connectFlowType = useGet(connectFlowType$);
  const pollingType = useGet(pollingOAuthAuthCodeConnectorType$);
  const connectorOAuthDeviceAuthState = useGet(connectorOAuthDeviceAuthState$);
  const connectorExternalCodeState = useGet(connectorExternalCodeState$);

  const item = connectorTypes?.find((c) => {
    return c.type === selectedType;
  });

  if (!selectedType || !item) {
    return null;
  }

  const config = CONNECTOR_TYPES[selectedType];
  const connectFlowActive =
    connectFlowType === selectedType ||
    pollingType === selectedType ||
    connectorOAuthDeviceAuthFlowIsActive(
      connectorOAuthDeviceAuthState,
      selectedType,
    ) ||
    connectorExternalCodeFlowIsActive(connectorExternalCodeState, selectedType);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          clearConnectorOAuthDeviceAuth();
          clearConnectorExternalCode();
          onClose();
        }
      }}
    >
      <DialogContent
        className="max-w-md"
        aria-describedby={undefined}
        onInteractOutside={(event) => {
          if (connectFlowActive) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-5 w-5 shrink-0 items-center justify-center">
              <ConnectorIcon type={selectedType} size={20} />
            </div>
            <DialogTitle>{config.label}</DialogTitle>
          </div>
        </DialogHeader>

        {item.connected && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{connectedStatusText(item)}</span>
          </p>
        )}

        <ConnectModalContent
          item={item}
          showPermissionDialogOnConnect={showPermissionDialogOnConnect}
          onSuccess={async () => {
            await onSuccess?.();
            clearConnectorOAuthDeviceAuth();
            clearConnectorExternalCode();
            onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Connector card (shows Connect button when not connected)
// ---------------------------------------------------------------------------
