import {
  useLastLoadable,
  useLastResolved,
  useGet,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Input } from "@vm0/ui/components/ui/input";
import { Button } from "@vm0/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import {
  CONNECTOR_TYPES,
  type ConnectorAuthMethodType,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import type { ReactElement } from "react";
import type { LocalBrowserHost } from "@vm0/api-contracts/contracts/zero-local-browser";
import { isGoogleOAuthConnector } from "@vm0/connectors/connector-utils";
import {
  allConnectorTypes$,
  pollingConnectorType$,
  connectAndSettle$,
  submitApiToken$,
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
  type ConnectorTypeWithStatus,
} from "../../../../signals/zero-page/settings/connectors.ts";
import { hasTokenInputValue } from "../../../../signals/zero-page/settings/token-input.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { ConnectorIcon } from "./connector-icons.tsx";
import { detach, onDomEventFn, Reason } from "../../../../signals/utils.ts";
import { GoogleOAuthNotice } from "../../zero-directed-shared.tsx";

// ---------------------------------------------------------------------------
// Inline markdown renderer for help text
// ---------------------------------------------------------------------------

// Only intended for trusted, source-controlled help text from
// `CONNECTOR_TYPES[*].authMethods.*.helpText`. Do NOT feed user-supplied
// strings into this renderer — the `[text]`, `**bold**`, and `> quote`
// captures are verbatim-injected and would permit HTML smuggling.
function renderMarkdown(text: string): string {
  return text
    .replace(
      // Only http(s) URLs are turned into anchors; other schemes fall through
      // as literal text. `"` is also excluded from the href charclass so a
      // stray quote cannot break out of the href attribute and inject
      // siblings like `onclick` when feeding `dangerouslySetInnerHTML`.
      /\[([^\]]+)\]\((https?:\/\/[^)"]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-primary underline">$1</a>',
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(
      /^> (.+)$/gm,
      '<div class="pl-3 border-l-2 border-muted text-muted-foreground">$1</div>',
    );
}

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

type SubmitApiTokenFn = (
  type: ConnectorType,
  inputSecrets: Record<string, string>,
  options: PostConnectOptions,
  signal: AbortSignal,
) => Promise<void>;

type ConnectAndSettleFn = (
  type: ConnectorType,
  onSuccess: () => void | Promise<void>,
  options: PostConnectOptions,
  signal: AbortSignal,
) => Promise<void>;

type ConnectModalContentProps = {
  item: ConnectorTypeWithStatus;
  onSuccess: () => void | Promise<void>;
  showPermissionDialogOnConnect: boolean;
};

type ConnectMethodContentProps = ConnectModalContentProps & {
  connectAndSettle: ConnectAndSettleFn;
  submitApiToken: SubmitApiTokenFn;
  credentialSubmitting: boolean;
  signal: AbortSignal;
};

type ApiConnectContentComponent = (
  props: ConnectModalContentProps,
) => ReactElement;

type ConnectMethodContentComponent = (
  props: ConnectMethodContentProps,
) => ReactElement;

type ConnectMethodContentEntry = {
  authMethod: ConnectorAuthMethodType;
  Content: ConnectMethodContentComponent;
};

// ---------------------------------------------------------------------------
// API Token form (shown inside connect modal)
// ---------------------------------------------------------------------------

function ApiTokenForm({
  type,
  item,
  onSuccess,
  showPermissionDialogOnConnect,
  submit,
  submitting,
}: {
  type: ConnectorType;
  item: ConnectorTypeWithStatus;
  onSuccess: () => void | Promise<void>;
  showPermissionDialogOnConnect: boolean;
  submit: SubmitApiTokenFn;
  submitting: boolean;
}) {
  const config = CONNECTOR_TYPES[type];
  const apiTokenConfig = config.authMethods["api-token"];
  const setFormValue = useSet(setTokenFormValue$);
  const clearForm = useSet(clearTokenForm$);
  const pageSignal = useGet(pageSignal$);
  const secretValues = useGet(tokenFormValuesFor$(type));

  if (!apiTokenConfig) {
    return null;
  }

  const secretEntries = Object.entries(apiTokenConfig.secrets);
  const allFilled = secretEntries.every(([name, cfg]) => {
    return !cfg.required || hasTokenInputValue(secretValues[name]);
  });

  const handleSubmit = onDomEventFn(async () => {
    if (!allFilled || submitting) {
      return;
    }
    await submit(
      type,
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
      {item.connected && item.connector?.authMethod === "oauth" && (
        <p className="text-xs text-amber-600">
          This will replace your current OAuth connection.
        </p>
      )}
      {apiTokenConfig.helpText && (
        <div
          className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line [&_a]:text-primary [&_a]:underline"
          dangerouslySetInnerHTML={{
            __html: renderMarkdown(apiTokenConfig.helpText),
          }}
        />
      )}
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
  onSuccess,
  showPermissionDialogOnConnect,
}: {
  item: ConnectorTypeWithStatus;
  onSuccess: () => void | Promise<void>;
  showPermissionDialogOnConnect: boolean;
}) {
  const config = CONNECTOR_TYPES[item.type];
  const localAgentConfig = config.authMethods.api;
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
      {localAgentConfig?.helpText && (
        <div
          className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line [&_a]:text-primary [&_a]:underline"
          dangerouslySetInnerHTML={{
            __html: renderMarkdown(localAgentConfig.helpText),
          }}
        />
      )}

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
  onSuccess,
  showPermissionDialogOnConnect,
}: {
  item: ConnectorTypeWithStatus;
  onSuccess: () => void | Promise<void>;
  showPermissionDialogOnConnect: boolean;
}) {
  const config = CONNECTOR_TYPES[item.type];
  const localBrowserConfig = config.authMethods.api;
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
      {localBrowserConfig?.helpText && (
        <div
          className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line [&_a]:text-primary [&_a]:underline"
          dangerouslySetInnerHTML={{
            __html: renderMarkdown(localBrowserConfig.helpText),
          }}
        />
      )}

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

function getOAuthProgressContent({
  isPolling,
  settling,
}: {
  isPolling: boolean;
  settling: boolean;
}) {
  // While OAuth is in progress, only show connecting state
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

function OAuthConnectButton({
  item,
  label,
  onSuccess,
  showPermissionDialogOnConnect,
  connectAndSettle,
  signal,
}: ConnectModalContentProps & {
  label: string;
  connectAndSettle: ConnectAndSettleFn;
  signal: AbortSignal;
}) {
  return (
    <Button
      variant="outline"
      onClick={() => {
        return detach(
          connectAndSettle(
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

function AuthMethodDivider() {
  return (
    <div className="relative">
      <div className="absolute inset-0 flex items-center">
        <span className="w-full zero-border-t" />
      </div>
      <div className="relative flex justify-center text-xs">
        <span className="bg-background px-2 text-muted-foreground">or</span>
      </div>
    </div>
  );
}

function OAuthConnectMethodContent(props: ConnectMethodContentProps) {
  return (
    <OAuthConnectButton
      item={props.item}
      label={CONNECTOR_TYPES[props.item.type].label}
      onSuccess={props.onSuccess}
      showPermissionDialogOnConnect={props.showPermissionDialogOnConnect}
      connectAndSettle={props.connectAndSettle}
      signal={props.signal}
    />
  );
}

function ApiTokenConnectMethodContent(props: ConnectMethodContentProps) {
  return (
    <ApiTokenForm
      type={props.item.type}
      item={props.item}
      onSuccess={props.onSuccess}
      showPermissionDialogOnConnect={props.showPermissionDialogOnConnect}
      submit={props.submitApiToken}
      submitting={props.credentialSubmitting}
    />
  );
}

function getApiConnectContentComponent(
  type: ConnectorType,
): ApiConnectContentComponent | null {
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
  authMethod: ConnectorAuthMethodType,
): ConnectMethodContentComponent | null {
  switch (authMethod) {
    case "oauth": {
      return OAuthConnectMethodContent;
    }
    case "api-token": {
      return ApiTokenConnectMethodContent;
    }
    case "cli-auth": {
      return null;
    }
    case "api": {
      return getApiConnectContentComponent(item.type);
    }
  }
}

function getConnectMethodContentEntries(
  item: ConnectorTypeWithStatus,
): ConnectMethodContentEntry[] {
  return item.availableAuthMethods.flatMap((authMethod) => {
    const Content = getConnectMethodContentComponent(item, authMethod);
    return Content ? [{ authMethod, Content }] : [];
  });
}

function ConnectMethodsContent({
  entries,
  availableAuthMethodCount,
  props,
}: {
  entries: readonly ConnectMethodContentEntry[];
  availableAuthMethodCount: number;
  props: ConnectMethodContentProps;
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

  return entries.map(({ authMethod, Content }, index) => {
    return (
      <div key={authMethod} className="contents">
        {index > 0 && <AuthMethodDivider />}
        <Content {...props} />
      </div>
    );
  });
}

function StandardConnectMethodsContent({
  item,
  onSuccess,
  showPermissionDialogOnConnect,
  connectAndSettle,
  submitApiToken,
  credentialSubmitting,
  signal,
}: ConnectModalContentProps & {
  connectAndSettle: ConnectAndSettleFn;
  submitApiToken: SubmitApiTokenFn;
  credentialSubmitting: boolean;
  signal: AbortSignal;
}) {
  const entries = getConnectMethodContentEntries(item);
  const isGoogleOAuth =
    entries.some((entry) => {
      return entry.authMethod === "oauth";
    }) && isGoogleOAuthConnector(item.type);

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
          connectAndSettle,
          submitApiToken,
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
  const [settleLoadable, connectAndSettle] = useLoadableSet(connectAndSettle$);
  const [apiTokenLoadable, submitApiToken] = useLoadableSet(submitApiToken$);
  const pageSignal = useGet(pageSignal$);
  const pollingType = useGet(pollingConnectorType$);
  const settling = settleLoadable.state === "loading";
  const credentialSubmitting = apiTokenLoadable.state === "loading";
  const isPolling = pollingType === item.type;

  const progressContent = item.availableAuthMethods.includes("oauth")
    ? getOAuthProgressContent({
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
      onSuccess={onSuccess}
      showPermissionDialogOnConnect={showPermissionDialogOnConnect}
      connectAndSettle={connectAndSettle}
      submitApiToken={submitApiToken}
      credentialSubmitting={credentialSubmitting}
      signal={pageSignal}
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

  const item = connectorTypes?.find((c) => {
    return c.type === selectedType;
  });

  if (!selectedType || !item) {
    return null;
  }

  const config = CONNECTOR_TYPES[selectedType];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && onClose();
      }}
    >
      <DialogContent className="max-w-md" aria-describedby={undefined}>
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
