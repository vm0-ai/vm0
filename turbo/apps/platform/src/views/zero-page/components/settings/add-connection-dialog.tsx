import { useLastResolved, useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { toast } from "@vm0/ui/components/ui/sonner";
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
  isGoogleOAuthConnector,
} from "@vm0/core";
import {
  allConnectorTypes$,
  pollingConnectorType$,
  connectAndSettle$,
  enablePlatformConnector$,
  submitApiToken$,
  tokenFormSubmitting$,
  setTokenFormValue$,
  clearTokenForm$,
  tokenFormValuesFor$,
  setTokenFormSubmitting$,
  selectedConnectorType$,
  isStandaloneMode,
  type ConnectorTypeWithStatus,
} from "../../../../signals/zero-page/settings/connectors.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { ConnectorIcon } from "./connector-icons.tsx";
import { Vm0ManagedBadge } from "./vm0-managed-badge.tsx";
import { detach, Reason } from "../../../../signals/utils.ts";
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

// ---------------------------------------------------------------------------
// API Token form (shown inside connect modal)
// ---------------------------------------------------------------------------

function ApiTokenForm({
  type,
  item,
  onSuccess,
}: {
  type: ConnectorType;
  item: ConnectorTypeWithStatus;
  onSuccess: () => void | Promise<void>;
}) {
  const config = CONNECTOR_TYPES[type];
  const apiTokenConfig = config.authMethods["api-token"];
  const submit = useSet(submitApiToken$);
  const setFormValue = useSet(setTokenFormValue$);
  const clearForm = useSet(clearTokenForm$);
  const pageSignal = useGet(pageSignal$);
  const secretValues = useGet(tokenFormValuesFor$(type));
  const submittingType = useGet(tokenFormSubmitting$);
  const setSubmitting = useSet(setTokenFormSubmitting$);
  const submitting = submittingType === type;

  if (!apiTokenConfig) {
    return null;
  }

  const secretEntries = Object.entries(apiTokenConfig.secrets);
  const allFilled = secretEntries.every(([name, cfg]) => {
    return !cfg.required || secretValues[name];
  });

  const handleSubmit = () => {
    if (!allFilled || submitting) {
      return;
    }
    setSubmitting(type);
    detach(
      (async () => {
        await submit(type, secretValues, pageSignal);
        setSubmitting(null);
        clearForm(type);
        await onSuccess();
      })().catch((error: unknown) => {
        setSubmitting(null);
        const message =
          error instanceof Error ? error.message : "Please try again";
        toast.error(`Failed to save ${config.label} credentials`, {
          id: `connector-save-failed-${type}`,
          description: message,
        });
      }),
      Reason.DomCallback,
    );
  };

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

// ---------------------------------------------------------------------------
// Platform confirmation form (platform-supplied connectors — no credentials, just terms)
// ---------------------------------------------------------------------------

function PlatformConfirmationForm({
  type,
  onSuccess,
}: {
  type: ConnectorType;
  onSuccess: () => void | Promise<void>;
}) {
  const config = CONNECTOR_TYPES[type];
  const platformConfig = config.authMethods.platform;
  const enable = useSet(enablePlatformConnector$);
  const pageSignal = useGet(pageSignal$);
  const submittingType = useGet(tokenFormSubmitting$);
  const setSubmitting = useSet(setTokenFormSubmitting$);
  const submitting = submittingType === type;

  if (!platformConfig) {
    return null;
  }

  const handleEnable = () => {
    if (submitting) {
      return;
    }
    setSubmitting(type);
    detach(
      (async () => {
        await enable(type, pageSignal);
        setSubmitting(null);
        await onSuccess();
      })().catch((error: unknown) => {
        setSubmitting(null);
        const message =
          error instanceof Error ? error.message : "Please try again";
        toast.error(`Failed to enable ${config.label}`, {
          id: `connector-enable-failed-${type}`,
          description: message,
        });
      }),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {platformConfig.helpText && (
        <div
          className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line [&_a]:text-primary [&_a]:underline"
          dangerouslySetInnerHTML={{
            __html: renderMarkdown(platformConfig.helpText),
          }}
        />
      )}
      <Button onClick={handleEnable} disabled={submitting} className="w-full">
        {submitting ? "Enabling..." : (platformConfig.label ?? "Enable")}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect modal content (OAuth button + token form, or just token form)
// ---------------------------------------------------------------------------

function ConnectModalContent({
  item,
  onSuccess,
}: {
  item: ConnectorTypeWithStatus;
  onSuccess: () => void | Promise<void>;
}) {
  const [settleLoadable, connectAndSettle] = useLoadableSet(connectAndSettle$);
  const pageSignal = useGet(pageSignal$);
  const pollingType = useGet(pollingConnectorType$);
  const settling = settleLoadable.state === "loading";
  const isPolling = pollingType === item.type;

  const config = CONNECTOR_TYPES[item.type];
  const hasOAuth = item.availableAuthMethods.includes("oauth");
  const hasApiToken = item.availableAuthMethods.includes("api-token");
  const hasPlatform = item.availableAuthMethods.includes("platform");

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
              connectAndSettle(item.type, onSuccess, pageSignal),
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
        <ApiTokenForm type={item.type} item={item} onSuccess={onSuccess} />
      )}

      {hasApiToken && hasPlatform && (
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full zero-border-t" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-background px-2 text-muted-foreground">or</span>
          </div>
        </div>
      )}

      {hasPlatform && (
        <PlatformConfirmationForm type={item.type} onSuccess={onSuccess} />
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
}: {
  onClose: () => void;
  onSuccess?: () => void | Promise<void>;
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
            {item.connector?.authMethod === "platform" && <Vm0ManagedBadge />}
          </p>
        )}

        <ConnectModalContent
          item={item}
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
