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
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { isGoogleOAuthConnector } from "@vm0/connectors/connector-utils";
import {
  allConnectorTypes$,
  pollingConnectorType$,
  connectAndSettle$,
  submitApiToken$,
  setTokenFormValue$,
  clearTokenForm$,
  connectRemoteAgentConnector$,
  tokenFormValuesFor$,
  selectedConnectorType$,
  isStandaloneMode,
  REMOTE_AGENT_CONNECTOR_TYPE,
  getRemoteAgentOnlineHosts,
  remoteAgentHostsWatcherRef$,
  remoteAgentHosts$,
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
  if (item.type === REMOTE_AGENT_CONNECTOR_TYPE) {
    const count = item.remoteAgentHosts?.length ?? 0;
    return count === 1 ? "1 host online" : `${count} hosts online`;
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

function formatRemoteAgentBackends(backends: readonly string[]): string {
  return backends
    .map((backend) => {
      return backend === "claude-code" ? "Claude Code" : "Codex";
    })
    .join(", ");
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

function RemoteAgentConnectContent({
  item,
  onSuccess,
  showPermissionDialogOnConnect,
}: {
  item: ConnectorTypeWithStatus;
  onSuccess: () => void | Promise<void>;
  showPermissionDialogOnConnect: boolean;
}) {
  const config = CONNECTOR_TYPES[item.type];
  const remoteAgentConfig = config.authMethods.api;
  const hostListLoadable = useLastLoadable(remoteAgentHosts$);
  const watchHostsRef = useSet(remoteAgentHostsWatcherRef$);
  const [connectLoadable, connectRemoteAgent] = useLoadableSet(
    connectRemoteAgentConnector$,
  );
  const pageSignal = useGet(pageSignal$);
  const hosts =
    hostListLoadable.state === "hasData"
      ? getRemoteAgentOnlineHosts(hostListLoadable.data.hosts)
      : (item.remoteAgentHosts ?? []);
  const loading = hostListLoadable.state === "loading";
  const connecting = connectLoadable.state === "loading";
  const canConnect = !item.connected && hosts.length > 0 && !connecting;

  const handleConnect = onDomEventFn(async () => {
    if (!canConnect) {
      return;
    }
    await connectRemoteAgent(
      { showPermissionDialog: showPermissionDialogOnConnect },
      pageSignal,
    );
    await onSuccess();
  });

  return (
    <div ref={watchHostsRef} className="flex flex-col gap-3">
      {remoteAgentConfig?.helpText && (
        <div
          className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line [&_a]:text-primary [&_a]:underline"
          dangerouslySetInnerHTML={{
            __html: renderMarkdown(remoteAgentConfig.helpText),
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
                  {formatRemoteAgentBackends(host.supportedBackends)}
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

// ---------------------------------------------------------------------------
// Connect modal content (OAuth button + token form, or just token form)
// ---------------------------------------------------------------------------

function ConnectModalContent({
  item,
  onSuccess,
  showPermissionDialogOnConnect,
}: {
  item: ConnectorTypeWithStatus;
  onSuccess: () => void | Promise<void>;
  showPermissionDialogOnConnect: boolean;
}) {
  const [settleLoadable, connectAndSettle] = useLoadableSet(connectAndSettle$);
  const [apiTokenLoadable, submitApiToken] = useLoadableSet(submitApiToken$);
  const pageSignal = useGet(pageSignal$);
  const pollingType = useGet(pollingConnectorType$);
  const settling = settleLoadable.state === "loading";
  const credentialSubmitting = apiTokenLoadable.state === "loading";
  const isPolling = pollingType === item.type;

  const config = CONNECTOR_TYPES[item.type];
  const hasOAuth = item.availableAuthMethods.includes("oauth");
  const hasApiToken = item.availableAuthMethods.includes("api-token");

  if (item.type === REMOTE_AGENT_CONNECTOR_TYPE) {
    return (
      <RemoteAgentConnectContent
        item={item}
        onSuccess={onSuccess}
        showPermissionDialogOnConnect={showPermissionDialogOnConnect}
      />
    );
  }

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

  const isGoogleOAuth = hasOAuth && isGoogleOAuthConnector(item.type);

  return (
    <div className="flex flex-col gap-4">
      {isGoogleOAuth && <GoogleOAuthNotice />}

      {hasOAuth && (
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
                pageSignal,
              ),
              Reason.DomCallback,
            );
          }}
          className="w-full"
        >
          Sign in with {config.label}
        </Button>
      )}

      {hasOAuth && hasApiToken && (
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full zero-border-t" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-background px-2 text-muted-foreground">or</span>
          </div>
        </div>
      )}

      {hasApiToken && (
        <ApiTokenForm
          type={item.type}
          item={item}
          onSuccess={onSuccess}
          showPermissionDialogOnConnect={showPermissionDialogOnConnect}
          submit={submitApiToken}
          submitting={credentialSubmitting}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect modal (opened when clicking Connect on a connector with api-token)
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
