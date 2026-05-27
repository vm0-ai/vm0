import {
  useLastLoadable,
  useLastResolved,
  useGet,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Input } from "@vm0/ui/components/ui/input";
import { Button } from "@vm0/ui/components/ui/button";
import { CopyButton } from "@vm0/ui/components/ui/copy-button";
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
  type ConnectorManualGrantConfig,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import type { ReactElement } from "react";
import type { LocalBrowserHost } from "@vm0/api-contracts/contracts/zero-local-browser";
import {
  connectorAuthMethodHasOAuthGrant,
  getConnectorAuthMethod,
  isGoogleOAuthConnector,
  hasConnectorAuthCodeGrant,
  hasConnectorDeviceAuthGrant,
} from "@vm0/connectors/connector-utils";
import {
  allConnectorTypes$,
  connectFlowType$,
  pollingOAuthAuthCodeConnectorType$,
  connectorOAuthDeviceAuthState$,
  connectConnectorOAuthAuthCodeAndSettle$,
  connectConnectorOAuthDeviceAuthAndSettle$,
  openConnectorOAuthDeviceAuthVerificationPage$,
  clearConnectorOAuthDeviceAuth$,
  runConnectorConnectSuccess$,
  submitManualCredentials$,
  setTokenFormValue$,
  clearTokenForm$,
  connectLocalAgentConnector$,
  connectLocalBrowserConnector$,
  deleteLocalBrowserHost$,
  detectLocalBrowserExtension$,
  pairLocalBrowserExtension$,
  tokenFormValuesFor$,
  selectedConnectorType$,
  isStandaloneMode,
  LOCAL_AGENT_CONNECTOR_TYPE,
  LOCAL_BROWSER_CONNECTOR_TYPE,
  getLocalAgentOnlineHosts,
  getLocalBrowserOnlineHosts,
  localBrowserConnectionRef$,
  localBrowserExtensionStatus$,
  localBrowserHosts$,
  localAgentHostsWatcherRef$,
  localAgentHosts$,
  type LocalBrowserExtensionStatus,
  type ConnectorOAuthDeviceAuthState,
  type ConnectorTypeWithStatus,
} from "../../../../signals/zero-page/settings/connectors.ts";
import { hasTokenInputValue } from "../../../../signals/zero-page/settings/token-input.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { ConnectorIcon } from "./connector-icons.tsx";
import { detach, onDomEventFn, Reason } from "../../../../signals/utils.ts";
import { GoogleOAuthNotice } from "../../zero-directed-shared.tsx";
import { ConnectorHelpText } from "./connector-help-text.tsx";

// ---------------------------------------------------------------------------
// Connected status text helper
// ---------------------------------------------------------------------------

function connectedStatusText(item: ConnectorTypeWithStatus): string {
  if (item.type === LOCAL_AGENT_CONNECTOR_TYPE) {
    const count = item.localAgentHosts?.length ?? 0;
    return count === 1 ? "1 host online" : `${count} hosts online`;
  }
  if (item.type === LOCAL_BROWSER_CONNECTOR_TYPE) {
    const count = item.localBrowserHosts?.length ?? 0;
    return count === 1 ? "1 browser online" : `${count} browsers online`;
  }
  if (item.needsReconnect) {
    return "Connection expired";
  }
  if (item.scopeMismatch) {
    return "Permissions update available";
  }
  if (item.connector?.externalUsername) {
    return `Connected as @${item.connector.externalUsername}`;
  }
  return "Connected";
}

function formatLocalAgentBackends(backends: readonly string[]): string {
  return backends
    .map((backend) => {
      return backend === "claude-code" ? "Claude Code" : "Codex";
    })
    .join(", ");
}

function formatLocalBrowserCapabilities(
  capabilities: readonly string[],
): string {
  if (capabilities.length === 0) {
    return "Browser automation";
  }
  return capabilities.slice(0, 3).join(", ");
}

function localBrowserExtensionStatusText(
  status: LocalBrowserExtensionStatus,
): string {
  switch (status.status) {
    case "checking": {
      return "Checking extension...";
    }
    case "available": {
      return status.browser
        ? `${status.browser} extension ready`
        : "Extension ready";
    }
    case "pairing": {
      return "Pairing extension...";
    }
    case "missing": {
      return "Extension not detected";
    }
    case "error": {
      return status.message;
    }
    case "unknown": {
      return "Extension status unknown";
    }
  }
}

type PostConnectOptions = {
  readonly showPermissionDialog?: boolean;
};

type SubmitManualCredentialsFn = (
  type: ConnectorType,
  authMethod: ConnectorAuthMethodId,
  inputSecrets: Record<string, string>,
  options: PostConnectOptions,
  signal: AbortSignal,
) => Promise<void>;

type ConnectOAuthAuthCodeAndSettleFn = (
  type: ConnectorType,
  onSuccess: () => void | Promise<void>,
  options: PostConnectOptions,
  signal: AbortSignal,
) => Promise<void>;

type ConnectOAuthDeviceAuthAndSettleFn = ConnectOAuthAuthCodeAndSettleFn;

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
  submitManualCredentials: SubmitManualCredentialsFn;
  credentialSubmitting: boolean;
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

function connectedConnectorHasOAuthGrant(
  item: ConnectorTypeWithStatus,
): boolean {
  return item.connector
    ? connectorAuthMethodHasOAuthGrant(item.type, item.connector.authMethod)
    : false;
}

// ---------------------------------------------------------------------------
// Manual credentials form (shown inside connect modal)
// ---------------------------------------------------------------------------

function ManualCredentialForm({
  type,
  authMethod,
  method,
  grant,
  item,
  onSuccess,
  showPermissionDialogOnConnect,
  submit,
  submitting,
}: {
  type: ConnectorType;
  authMethod: ConnectorAuthMethodId;
  method: ConnectorAuthMethodConfig;
  grant: ConnectorManualGrantConfig;
  item: ConnectorTypeWithStatus;
  onSuccess: () => void | Promise<void>;
  showPermissionDialogOnConnect: boolean;
  submit: SubmitManualCredentialsFn;
  submitting: boolean;
}) {
  const setFormValue = useSet(setTokenFormValue$);
  const clearForm = useSet(clearTokenForm$);
  const pageSignal = useGet(pageSignal$);
  const secretValues = useGet(tokenFormValuesFor$(type));

  const secretEntries = Object.entries(grant.fields);
  const allFilled = secretEntries.every(([name, cfg]) => {
    return !cfg.required || hasTokenInputValue(secretValues[name]);
  });

  const handleSubmit = onDomEventFn(async () => {
    if (!allFilled || submitting) {
      return;
    }
    await submit(
      type,
      authMethod,
      secretValues,
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
      {item.connected && connectedConnectorHasOAuthGrant(item) && (
        <p className="text-xs text-amber-600">
          This will replace your current OAuth connection.
        </p>
      )}
      {method.helpText && <ConnectorHelpText text={method.helpText} />}
      {secretEntries.map(([name, secretConfig]) => {
        return (
          <div key={name} className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-foreground">
              {secretConfig.label}
            </label>
            <Input
              type="password"
              placeholder={secretConfig.placeholder}
              value={secretValues[name] ?? ""}
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

function LocalAgentConnectContent({
  item,
  method,
  onSuccess,
  showPermissionDialogOnConnect,
}: ConnectMethodContentProps) {
  const hostListLoadable = useLastLoadable(localAgentHosts$);
  const watchHostsRef = useSet(localAgentHostsWatcherRef$);
  const [connectLoadable, connectLocalAgent] = useLoadableSet(
    connectLocalAgentConnector$,
  );
  const pageSignal = useGet(pageSignal$);
  const hosts =
    hostListLoadable.state === "hasData"
      ? getLocalAgentOnlineHosts(hostListLoadable.data.hosts)
      : (item.localAgentHosts ?? []);
  const loading = hostListLoadable.state === "loading";
  const connecting = connectLoadable.state === "loading";
  const canConnect = !item.connected && hosts.length > 0 && !connecting;

  const handleConnect = onDomEventFn(async () => {
    if (!canConnect) {
      return;
    }
    await connectLocalAgent(
      { showPermissionDialog: showPermissionDialogOnConnect },
      pageSignal,
    );
    await onSuccess();
  });

  return (
    <div ref={watchHostsRef} className="flex flex-col gap-3">
      {method.helpText && <ConnectorHelpText text={method.helpText} />}

      <div className="mt-1 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">Online hosts</h3>
        <span className="text-xs text-muted-foreground">
          {loading ? "Checking..." : "Updates automatically"}
        </span>
      </div>

      {loading && hosts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading hosts...</p>
      ) : hosts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No online hosts yet. Start one with the command above; this list
          updates automatically.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-border/50 rounded-lg border border-border/60">
          {hosts.map((host) => {
            return (
              <div key={host.id} className="flex flex-col gap-1 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">
                    {host.displayName}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {formatLocalAgentBackends(host.supportedBackends)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {!item.connected && (
        <Button
          type="button"
          onClick={handleConnect}
          disabled={!canConnect}
          className="w-full"
        >
          {connecting ? "Connecting..." : "Connect"}
        </Button>
      )}
    </div>
  );
}

function LocalBrowserExtensionPanel({
  status,
  checking,
  pairing,
  onDetect,
  onPair,
}: {
  status: LocalBrowserExtensionStatus;
  checking: boolean;
  pairing: boolean;
  onDetect: (event: unknown) => void;
  onPair: (event: unknown) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">
          Browser extension
        </span>
        <span className="text-xs text-muted-foreground">
          {localBrowserExtensionStatusText(status)}
        </span>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onDetect}
          disabled={checking}
          className="h-8 flex-1"
        >
          {checking ? "Checking..." : "Check extension"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onPair}
          disabled={checking || pairing}
          className="h-8 flex-1"
        >
          {pairing ? "Pairing..." : "Pair extension"}
        </Button>
      </div>
    </div>
  );
}

function LocalBrowserHostList({
  hosts,
  loading,
  deletingHost,
  onDeleteHost,
}: {
  hosts: readonly LocalBrowserHost[];
  loading: boolean;
  deletingHost: boolean;
  onDeleteHost: (hostId: string) => void;
}) {
  if (loading && hosts.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading browsers...</p>;
  }

  if (hosts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No paired browsers yet. Pair the extension above; this list updates
        automatically.
      </p>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border/50 rounded-lg border border-border/60">
      {hosts.map((host) => {
        const isOnline = host.status === "online";
        return (
          <div
            key={host.id}
            className="flex items-center justify-between gap-3 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    isOnline ? "bg-emerald-500" : "bg-muted-foreground/40"
                  }`}
                />
                <span className="min-w-0 truncate text-sm font-medium text-foreground">
                  {host.displayName}
                </span>
              </div>
              <span className="block truncate text-xs text-muted-foreground">
                {host.browser} {host.extensionVersion} -{" "}
                {formatLocalBrowserCapabilities(host.supportedCapabilities)}
              </span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={deletingHost}
              onClick={() => {
                onDeleteHost(host.id);
              }}
              className="h-8 shrink-0 px-2 text-xs"
            >
              Revoke
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function LocalBrowserConnectContent({
  item,
  method,
  onSuccess,
  showPermissionDialogOnConnect,
}: ConnectMethodContentProps) {
  const hostListLoadable = useLastLoadable(localBrowserHosts$);
  const watchConnectionRef = useSet(localBrowserConnectionRef$);
  const extensionStatus = useGet(localBrowserExtensionStatus$);
  const [detectLoadable, detectExtension] = useLoadableSet(
    detectLocalBrowserExtension$,
  );
  const [pairLoadable, pairExtension] = useLoadableSet(
    pairLocalBrowserExtension$,
  );
  const [deleteHostLoadable, deleteHost] = useLoadableSet(
    deleteLocalBrowserHost$,
  );
  const [connectLoadable, connectLocalBrowser] = useLoadableSet(
    connectLocalBrowserConnector$,
  );
  const pageSignal = useGet(pageSignal$);
  const hosts =
    hostListLoadable.state === "hasData"
      ? hostListLoadable.data.hosts
      : (item.localBrowserHosts ?? []);
  const onlineHosts = getLocalBrowserOnlineHosts(hosts);
  const loadingHosts = hostListLoadable.state === "loading";
  const checkingExtension =
    extensionStatus.status === "checking" || detectLoadable.state === "loading";
  const pairingExtension =
    extensionStatus.status === "pairing" || pairLoadable.state === "loading";
  const connecting = connectLoadable.state === "loading";
  const deletingHost = deleteHostLoadable.state === "loading";
  const canConnect = !item.connected && onlineHosts.length > 0 && !connecting;

  const handleDetect = onDomEventFn(async () => {
    if (checkingExtension) {
      return;
    }
    await detectExtension(pageSignal);
  });

  const handlePair = onDomEventFn(async () => {
    if (pairingExtension || checkingExtension) {
      return;
    }
    await pairExtension(pageSignal);
  });

  const handleConnect = onDomEventFn(async () => {
    if (!canConnect) {
      return;
    }
    await connectLocalBrowser(
      { showPermissionDialog: showPermissionDialogOnConnect },
      pageSignal,
    );
    await onSuccess();
  });

  const handleDeleteHost = (hostId: string) => {
    detach(deleteHost(hostId, pageSignal), Reason.DomCallback);
  };

  return (
    <div ref={watchConnectionRef} className="flex flex-col gap-3">
      {method.helpText && <ConnectorHelpText text={method.helpText} />}

      <LocalBrowserExtensionPanel
        status={extensionStatus}
        checking={checkingExtension}
        pairing={pairingExtension}
        onDetect={handleDetect}
        onPair={handlePair}
      />

      <div className="mt-1 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">Browser hosts</h3>
        <span className="text-xs text-muted-foreground">
          {loadingHosts ? "Checking..." : "Updates automatically"}
        </span>
      </div>

      <LocalBrowserHostList
        hosts={hosts}
        loading={loadingHosts}
        deletingHost={deletingHost}
        onDeleteHost={handleDeleteHost}
      />

      {!item.connected && (
        <Button
          type="button"
          onClick={handleConnect}
          disabled={!canConnect}
          className="w-full"
        >
          {connecting ? "Connecting..." : "Connect"}
        </Button>
      )}
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
  label,
  onSuccess,
  showPermissionDialogOnConnect,
  connectOAuthAuthCodeAndSettle,
  signal,
}: ConnectModalContentProps & {
  label: string;
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
      Sign in with {label}
    </Button>
  );
}

function OAuthAuthCodeConnectMethodContent(props: ConnectMethodContentProps) {
  return (
    <OAuthAuthCodeConnectButton
      item={props.item}
      label={CONNECTOR_TYPES[props.item.type].label}
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

function OAuthDeviceAuthConnectMethodContent(props: ConnectMethodContentProps) {
  const state = useGet(connectorOAuthDeviceAuthState$);
  const openVerificationPage = useSet(
    openConnectorOAuthDeviceAuthVerificationPage$,
  );
  const current = state.connectorType === props.item.type ? state : null;
  const starting = current?.status === "starting";

  const start = onDomEventFn(async () => {
    await props.connectOAuthDeviceAuthAndSettle(
      props.item.type,
      props.onSuccess,
      {
        showPermissionDialog: props.showPermissionDialogOnConnect,
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
          openVerificationPage(props.item.type);
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
        <p className="text-sm text-destructive" role="alert">
          {current.message}
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={start}
          disabled={starting}
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
      <Button
        type="button"
        variant="outline"
        onClick={start}
        disabled={starting}
        className="w-full"
      >
        {starting
          ? "Starting..."
          : `Connect ${CONNECTOR_TYPES[props.item.type].label}`}
      </Button>
    </div>
  );
}

function ManualCredentialConnectMethodContent(
  props: ConnectMethodContentProps,
) {
  if (props.method.grant.kind !== "manual") {
    return null;
  }
  return (
    <ManualCredentialForm
      type={props.item.type}
      authMethod={props.authMethod}
      method={props.method}
      grant={props.method.grant}
      item={props.item}
      onSuccess={props.onSuccess}
      showPermissionDialogOnConnect={props.showPermissionDialogOnConnect}
      submit={props.submitManualCredentials}
      submitting={props.credentialSubmitting}
    />
  );
}

function getManagedConnectContentComponent(
  type: ConnectorType,
): ConnectMethodContentComponent | null {
  switch (type) {
    case LOCAL_AGENT_CONNECTOR_TYPE: {
      return LocalAgentConnectContent;
    }
    case LOCAL_BROWSER_CONNECTOR_TYPE: {
      return LocalBrowserConnectContent;
    }
    default: {
      return null;
    }
  }
}

function getConnectMethodContentComponent(
  item: ConnectorTypeWithStatus,
  method: ConnectorAuthMethodConfig,
): ConnectMethodContentComponent | null {
  switch (method.grant.kind) {
    case "auth-code": {
      if (hasConnectorAuthCodeGrant(item.type)) {
        return OAuthAuthCodeConnectMethodContent;
      }
      return null;
    }
    case "device-auth": {
      if (hasConnectorDeviceAuthGrant(item.type)) {
        return OAuthDeviceAuthConnectMethodContent;
      }
      return null;
    }
    case "manual": {
      return ManualCredentialConnectMethodContent;
    }
    case "managed": {
      return getManagedConnectContentComponent(item.type);
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
    const Content = getConnectMethodContentComponent(item, method);
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
          <div key={authMethod} className="flex flex-col gap-3">
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
  submitManualCredentials,
  credentialSubmitting,
  signal,
  entries,
}: ConnectModalContentProps & {
  connectOAuthAuthCodeAndSettle: ConnectOAuthAuthCodeAndSettleFn;
  connectOAuthDeviceAuthAndSettle: ConnectOAuthDeviceAuthAndSettleFn;
  submitManualCredentials: SubmitManualCredentialsFn;
  credentialSubmitting: boolean;
  signal: AbortSignal;
  entries: readonly ConnectMethodContentEntry[];
}) {
  const isGoogleOAuth =
    hasAuthCodeGrant(
      item.type,
      entries.map((entry) => {
        return entry.authMethod;
      }),
    ) && isGoogleOAuthConnector(item.type);

  return (
    <div className="flex flex-col gap-4">
      {isGoogleOAuth && <GoogleOAuthNotice />}

      <ConnectMethodsContent
        entries={entries}
        availableAuthMethodCount={item.availableAuthMethods.length}
        props={{
          item,
          onSuccess,
          showPermissionDialogOnConnect,
          connectOAuthAuthCodeAndSettle,
          connectOAuthDeviceAuthAndSettle,
          submitManualCredentials,
          credentialSubmitting,
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
  const [settleLoadable, connectOAuthAuthCodeAndSettle] = useLoadableSet(
    connectConnectorOAuthAuthCodeAndSettle$,
  );
  const [, connectOAuthDeviceAuthAndSettle] = useLoadableSet(
    connectConnectorOAuthDeviceAuthAndSettle$,
  );
  const [manualCredentialLoadable, submitManualCredentialsCommand] =
    useLoadableSet(submitManualCredentials$);
  const submitManualCredentials: SubmitManualCredentialsFn = async (
    type,
    authMethod,
    inputSecrets,
    options,
    signal,
  ) => {
    await submitManualCredentialsCommand(
      { type, authMethod, inputSecrets, options },
      signal,
    );
  };
  const [, runConnectSuccess] = useLoadableSet(runConnectorConnectSuccess$);
  const pageSignal = useGet(pageSignal$);
  const pollingType = useGet(pollingOAuthAuthCodeConnectorType$);
  const settling = settleLoadable.state === "loading";
  const credentialSubmitting = manualCredentialLoadable.state === "loading";
  const isPolling = pollingType === item.type;
  const entries = getConnectMethodContentEntries(item);
  const onConnectSuccess = async () => {
    await runConnectSuccess(item.type, onSuccess, pageSignal);
  };

  const progressContent =
    hasAuthCodeGrant(item.type, item.availableAuthMethods) &&
    hasConnectorAuthCodeGrant(item.type)
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
      connectOAuthDeviceAuthAndSettle={connectOAuthDeviceAuthAndSettle}
      submitManualCredentials={submitManualCredentials}
      credentialSubmitting={credentialSubmitting}
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
  const connectFlowType = useGet(connectFlowType$);
  const pollingType = useGet(pollingOAuthAuthCodeConnectorType$);
  const connectorOAuthDeviceAuthState = useGet(connectorOAuthDeviceAuthState$);

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
    );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          clearConnectorOAuthDeviceAuth();
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
